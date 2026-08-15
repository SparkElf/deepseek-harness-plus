import { resolveLocale, translate } from '/locales.js'

const badge = document.querySelector('#statusBadge')
const phase = document.querySelector('#phase')
const identity = document.querySelector('#runtimeIdentity')
const timeline = document.querySelector('#timeline')
const log = document.querySelector('#log')
const error = document.querySelector('#error')
const buttons = [...document.querySelectorAll('[data-command]')]
let snapshot
let locale = 'zh'

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
  document.querySelector('#brandSuffix').textContent = translate(locale, 'app.suffix')
  document.querySelector('#topbarTitle').textContent = translate(locale, 'app.supervisor')
  document.querySelector('#pageTitle').textContent = translate(locale, 'app.progress')
  document.querySelector('#phaseLabel').textContent = translate(locale, 'label.phase')
  document.querySelector('#activityTitle').textContent = translate(locale, 'label.activity')
  document.querySelector('#logTitle').textContent = translate(locale, 'label.log')
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

function renderLog(entries) {
  log.textContent = entries.length ? entries.map(entry => entry.kind === 'phase'
    ? '[' + timestamp(entry.at) + '] ' + phaseText(entry.phase)
    : entry.text).join(String.fromCharCode(10))
    : translate(locale, 'empty.log')
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
  phase.textContent = phaseText(command?.phase ?? data.runtime.phase)
  renderIdentity(data.runtime)
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
    const response = await fetch('/api/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }),
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
