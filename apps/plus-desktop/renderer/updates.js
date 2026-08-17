const bridge = window.plusUpdates
const versions = document.querySelector('#versions')
const current = document.querySelector('#current')
const status = document.querySelector('#status')
const error = document.querySelector('#error')
const refresh = document.querySelector('#refresh')
let locale = 'zh'
let snapshot

function t(zh, en) { return locale === 'zh' ? zh : en }
function setBusy(message) { status.textContent = message; error.textContent = ''; refresh.disabled = Boolean(message) }
function fail(caught) { status.textContent = ''; error.textContent = caught instanceof Error ? caught.message : String(caught); refresh.disabled = false }
function button(label, className, action, disabled = false) {
  const node = document.createElement('button')
  node.type = 'button'; node.className = 'command ' + className; node.textContent = label; node.disabled = disabled
  node.addEventListener('click', () => { void action() })
  return node
}
function render() {
  locale = snapshot.locale
  document.documentElement.lang = locale
  document.querySelector('#title').textContent = t('版本管理', 'Version manager')
  refresh.title = refresh.ariaLabel = t('刷新', 'Refresh')
  current.textContent = t('当前提交：', 'Current commit: ') + snapshot.currentRef.slice(0, 12)
  versions.setAttribute('aria-label', t('可用版本', 'Available versions'))
  if (snapshot.versions.length === 0) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = t('没有可用 release。', 'No releases are available.'); versions.replaceChildren(empty); return }
  versions.replaceChildren(...snapshot.versions.map(version => {
    const row = document.createElement('div'); row.className = 'version-row'
    const main = document.createElement('div'); main.className = 'version-main'
    const name = document.createElement('span'); name.className = 'version-name'; name.textContent = version.tag
    const ref = document.createElement('span'); ref.className = 'version-ref'; ref.textContent = version.sourceRef.slice(0, 12)
    main.append(name, ref)
    if (version.current) { const badge = document.createElement('span'); badge.className = 'current-badge'; badge.textContent = t('当前', 'Current'); main.append(badge) }
    const actions = document.createElement('div'); actions.className = 'version-actions'
    actions.append(
      button(t('普通升级/回退', 'Upgrade / Roll back'), 'primary', async () => {
        setBusy(t('正在切换版本…', 'Switching version…'))
        try { snapshot = await bridge.upgrade(version.sourceRef); render(); setBusy('') } catch (caught) { fail(caught) }
      }, version.current),
      button(t('AI 合并', 'AI merge'), '', async () => {
        setBusy(t('正在创建 AI 合并会话…', 'Creating AI merge session…'))
        try { await bridge.aiMerge(version.sourceRef); setBusy(t('AI 合并会话已打开。', 'AI merge session opened.')) } catch (caught) { fail(caught) }
      }, version.current),
    )
    row.append(main, actions); return row
  }))
}
async function load() { setBusy(t('正在读取 release…', 'Loading releases…')); try { snapshot = await bridge.list(); render(); setBusy('') } catch (caught) { fail(caught) } }
refresh.addEventListener('click', () => { void load() })
bridge.onProgress(update => { status.textContent = update.message })
void load()
