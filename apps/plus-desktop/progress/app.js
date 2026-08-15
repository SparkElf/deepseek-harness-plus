import { resolveLocale, translate } from '/locales.js'

const badge = document.querySelector('#statusBadge')
const identity = document.querySelector('#runtimeIdentity')
const timeline = document.querySelector('#timeline')
const log = document.querySelector('#log')
const error = document.querySelector('#error')
const branchInput = document.querySelector('#targetBranch')
const buttons = [...document.querySelectorAll('[data-command]')]
let snapshot
let locale = 'zh'
let branchInitialized = false

function text(value) {
  return value === undefined || value === '' ? translate(locale, 'empty.unavailable') : String(value)
}

function timestamp(value) {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}

function phaseText(value) {
  return translate(locale, 'phase.' + value.key, value.values)
}

function statusLabel(state) {
  return translate(locale, 'status.' + state)
}

function applyStaticCopy() {
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  document.title = translate(locale, 'app.supervisor')
  document.querySelector('#topbarTitle').textContent = translate(locale, 'app.supervisor')
  document.querySelector('#pageTitle').textContent = translate(locale, 'app.progress')
  document.querySelector('#activityTitle').textContent = translate(locale, 'label.activity')
  document.querySelector('#logTitle').textContent = translate(locale, 'label.log')
  document.querySelector('#branchLabel').textContent = translate(locale, 'label.targetBranch')
  document.querySelector('#commandActions').setAttribute('aria-label', translate(locale, 'label.commands'))
  document.querySelector('#startLabel').textContent = translate(locale, 'action.start')
  document.querySelector('#restartLabel').textContent = translate(locale, 'action.restart')
  document.querySelector('#rebuildLabel').textContent = translate(locale, 'action.rebuildRestart')
}

function renderIdentity(runtime) {
  const values = [
    ['label.source', runtime.installPath],
    ['label.branch', runtime.branch],
    ['label.revision', runtime.revision],
    ['label.home', runtime.dshHome],
    ['label.port', runtime.port],
    ['label.mode', runtime.mode],
    ['label.webPid', runtime.webPid],
    ['label.watcherPid', runtime.watcherPid],
  ]
  identity.replaceChildren(...values.map(([label, value]) => {
    const row = document.createElement('div')
    const key = document.createElement('dt')
    const current = document.createElement('dd')
    key.textContent = translate(locale, label)
    current.textContent = text(value)
    row.append(key, current)
    return row
  }))
}

function renderTimeline(entries) {
  timeline.replaceChildren(...entries.map((entry, index) => {
    const item = document.createElement('li')
    if (index === entries.length - 1) item.classList.add('latest')
    const dot = document.createElement('span')
    dot.className = 'timeline-dot'
    const content = document.createElement('div')
    const stamp = document.createElement('time')
    const message = document.createElement('span')
    stamp.textContent = timestamp(entry.at)
    message.textContent = phaseText(entry.phase)
    content.append(stamp, message)
    item.append(dot, content)
    return item
  }))
}

function logTone(entry) {
  if (entry.kind === 'phase') return 'phase'
  const value = entry.text
  if (/\b(error|failed|fatal)\b/i.test(value)) return 'error'
  if (/\b(warn|unsupported)\b/i.test(value)) return 'warning'
  if (/^(✓|✔)|build complete|done in/i.test(value)) return 'success'
  if (/^\$ |npm notice run/i.test(value)) return 'command'
  if (/^dist\//.test(value)) return 'artifact'
  return 'plain'
}

function logText(entry) {
  return entry.kind === 'phase'
    ? '[' + timestamp(entry.at) + '] ' + phaseText(entry.phase)
    : entry.text
}

function renderLog(entries) {
  if (!entries.length) {
    log.textContent = translate(locale, 'empty.log')
    return
  }
  log.replaceChildren(...entries.map(entry => {
    const row = document.createElement('div')
    row.className = 'log-row'
    row.dataset.tone = logTone(entry)
    const marker = document.createElement('span')
    marker.className = 'log-marker'
    marker.textContent = row.dataset.tone === 'success' ? '✓' : row.dataset.tone === 'warning' ? '!' : row.dataset.tone === 'error' ? '×' : row.dataset.tone === 'command' ? '$' : row.dataset.tone === 'artifact' ? '□' : '·'
    const message = document.createElement('span')
    message.className = 'log-message'
    message.textContent = logText(entry)
    row.append(marker, message)
    return row
  }))
  log.scrollTop = log.scrollHeight
}

function render(data) {
  snapshot = data
  locale = resolveLocale(data.runtime.locale, navigator.language)
  applyStaticCopy()
  const command = data.operation
  const active = command?.state === 'running'
  const state = command?.state === 'failed' ? 'failed' : active ? 'working' : data.runtime.state
  badge.dataset.state = state
  badge.lastElementChild.textContent = statusLabel(state)
  renderIdentity(data.runtime)
  if (!branchInitialized || (!active && document.activeElement !== branchInput)) {
    branchInput.value = data.runtime.branch ?? ''
    branchInitialized = true
  }
  branchInput.disabled = active
  buttons.forEach(button => {
    button.disabled = active || (button.dataset.command === 'start' && data.runtime.state === 'running') || (button.dataset.command === 'restart' && data.runtime.state !== 'running')
  })
  renderTimeline(data.timeline)
  renderLog(data.log)
  error.textContent = command?.state === 'failed' ? command.error || translate(locale, 'error.command') : ''
}

async function refresh() {
  const response = await fetch('/api/status', { cache: 'no-store' })
  if (!response.ok) throw new Error(translate(locale, 'error.status'))
  render(await response.json())
}

buttons.forEach(button => button.addEventListener('click', async () => {
  const command = button.dataset.command
  buttons.forEach(item => { item.disabled = true })
  error.textContent = ''
  try {
    const payload = { command }
    const targetBranch = branchInput.value.trim()
    if (command === 'rebuild-and-restart' && targetBranch !== '') payload.branch = targetBranch
    const response = await fetch('/api/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    if (snapshot?.operation?.state !== 'running') render({ ...snapshot, operation: result.operation })
  } catch (caught) {
    error.textContent = caught.message
    await refresh()
  }
}))

const stream = new EventSource('/events')
stream.addEventListener('status', event => render(JSON.parse(event.data)))
stream.addEventListener('progress', event => {
  if (snapshot === undefined) return
  const update = JSON.parse(event.data)
  const entry = { at: update.at, phase: update.operation.phase }
  snapshot = {
    ...snapshot,
    operation: update.operation,
    timeline: [...snapshot.timeline, entry].slice(-24),
    log: [...snapshot.log, { kind: 'phase', ...entry }].slice(-120),
  }
  render(snapshot)
})
stream.onerror = () => { error.textContent = translate(locale, 'error.connection') }

refresh().catch(caught => { error.textContent = caught.message })
