const messages = {
  zh: {
    'window.minimize': '最小化', 'window.maximize': '最大化', 'window.restore': '还原窗口', 'window.close': '关闭',
    'step.appearance': '外观', 'step.location': '安装位置', 'step.model': '模型', 'step.review': '确认',
    'title.appearance': '选择界面外观', 'title.location': '选择安装位置', 'title.model': '选择模型', 'title.review': '确认安装',
    'label.language': '语言', 'label.theme': '主题', 'label.distribution': '发行版', 'label.installPath': '安装目录', 'label.port': '端口',
    'label.provider': '模型提供方', 'label.apiKey': 'API 密钥', 'label.model': '模型名称', 'label.reasoning': '推理强度',
    'label.providerName': '服务名称', 'label.baseURL': '服务地址',
    'theme.system': '跟随系统', 'theme.light': '浅色', 'theme.dark': '深色',
    'target.windows': 'Windows', 'target.linux': 'Linux', 'target.macos': 'macOS',
    'provider.deepseek-official': 'DeepSeek', 'provider.openai': 'OpenAI', 'provider.anthropic': 'Anthropic', 'provider.google': 'Google',
    'provider.openrouter': 'OpenRouter', 'provider.groq': 'Groq', 'provider.mistral': 'Mistral', 'provider.xai': 'xAI', 'provider.custom': '自定义提供方',
    'action.choose': '选择文件夹', 'action.refresh': '刷新', 'action.back': '返回', 'action.cancel': '取消', 'action.continue': '继续', 'action.install': '安装',
    'advanced.title': '高级选项',
    'directory.title': '选择安装目录', 'directory.home': '主目录', 'directory.up': '返回上级', 'directory.edit': '编辑路径', 'directory.newFolder': '新建文件夹', 'directory.newFolderPlaceholder': '文件夹名称', 'directory.create': '创建', 'directory.showHidden': '显示隐藏文件', 'directory.open': '打开', 'directory.empty': '此目录中没有文件夹。',
    'placeholder.baseURL': '例如 https://api.example.com/v1',
    'reasoning.default': '默认', 'reasoning.low': '低', 'reasoning.medium': '中', 'reasoning.high': '高', 'reasoning.max': '最高',
    'summary.language': '语言', 'summary.theme': '主题', 'summary.location': '安装位置', 'summary.distribution': '发行版',
    'summary.folder': '安装目录', 'summary.provider': '模型提供方', 'summary.url': '服务地址', 'summary.model': '模型', 'summary.reasoning': '推理强度', 'summary.port': '端口',
    'error.location': '请选择安装目录。', 'error.distribution': '请选择 WSL 发行版。', 'error.reservedPort': '该端口不可用，请选择其他端口。',
    'error.model': '请填写 API 密钥和模型名称。', 'error.customName': '请填写服务名称。', 'error.customURL': '请填写服务地址。', 'error.customURLFormat': '服务地址必须是 HTTP 或 HTTPS URL。', 'error.distributions': '没有可用的 WSL 发行版。',
    'progress.distributions': '正在读取发行版…', 'progress.preparing': '正在开始安装…', 'progress.preview': '预览完成。',
    'window.title': '安装 DeepSeek Harness Plus',
  },
  en: {
    'window.minimize': 'Minimize', 'window.maximize': 'Maximize', 'window.restore': 'Restore window', 'window.close': 'Close',
    'step.appearance': 'Appearance', 'step.location': 'Location', 'step.model': 'Model', 'step.review': 'Review',
    'title.appearance': 'Choose the interface', 'title.location': 'Choose where to install', 'title.model': 'Choose a model', 'title.review': 'Ready to install',
    'label.language': 'Language', 'label.theme': 'Theme', 'label.distribution': 'Linux distribution', 'label.installPath': 'Installation folder', 'label.port': 'Port',
    'label.provider': 'Model provider', 'label.apiKey': 'API key', 'label.model': 'Model', 'label.reasoning': 'Reasoning',
    'label.providerName': 'Service name', 'label.baseURL': 'Service URL',
    'theme.system': 'System', 'theme.light': 'Light', 'theme.dark': 'Dark',
    'target.windows': 'Windows', 'target.linux': 'Linux', 'target.macos': 'macOS',
    'provider.deepseek-official': 'DeepSeek', 'provider.openai': 'OpenAI', 'provider.anthropic': 'Anthropic', 'provider.google': 'Google',
    'provider.openrouter': 'OpenRouter', 'provider.groq': 'Groq', 'provider.mistral': 'Mistral', 'provider.xai': 'xAI', 'provider.custom': 'Custom provider',
    'action.choose': 'Choose folder', 'action.refresh': 'Refresh', 'action.back': 'Back', 'action.cancel': 'Cancel', 'action.continue': 'Continue', 'action.install': 'Install',
    'advanced.title': 'Advanced',
    'directory.title': 'Choose installation folder', 'directory.home': 'Home', 'directory.up': 'Go to parent folder', 'directory.edit': 'Edit path', 'directory.newFolder': 'New folder', 'directory.newFolderPlaceholder': 'Folder name', 'directory.create': 'Create', 'directory.showHidden': 'Show hidden files', 'directory.open': 'Open', 'directory.empty': 'This folder has no subfolders.',
    'placeholder.baseURL': 'For example https://api.example.com/v1',
    'reasoning.default': 'Default', 'reasoning.low': 'Low', 'reasoning.medium': 'Medium', 'reasoning.high': 'High', 'reasoning.max': 'Max',
    'summary.language': 'Language', 'summary.theme': 'Theme', 'summary.location': 'Install location', 'summary.distribution': 'Linux distribution',
    'summary.folder': 'Installation folder', 'summary.provider': 'Model provider', 'summary.url': 'Service URL', 'summary.model': 'Model', 'summary.reasoning': 'Reasoning', 'summary.port': 'Port',
    'error.location': 'Choose an installation folder.', 'error.distribution': 'Choose a Linux distribution.', 'error.reservedPort': 'This port is unavailable. Choose another port.',
    'error.model': 'Enter an API key and model.', 'error.customName': 'Enter a service name.', 'error.customURL': 'Enter a service URL.', 'error.customURLFormat': 'The service URL must use HTTP or HTTPS.', 'error.distributions': 'No Linux distributions are available.',
    'progress.distributions': 'Loading Linux distributions…', 'progress.preparing': 'Starting installation…', 'progress.preview': 'Preview complete.',
    'window.title': 'Install DeepSeek Harness Plus',
  },
}

const providerDefaults = {
  'deepseek-official': 'deepseek-chat',
  openai: 'gpt-4.1',
  anthropic: 'claude-sonnet-4-5',
  google: 'gemini-2.5-pro',
  openrouter: 'openai/gpt-4.1',
  groq: 'llama-3.3-70b-versatile',
  mistral: 'mistral-large-latest',
  xai: 'grok-3',
  custom: '',
}
const providerIds = Object.keys(providerDefaults)
const params = new URLSearchParams(location.search)
const systemDark = matchMedia('(prefers-color-scheme: dark)')
const preview = window.plusInstaller === undefined
let progressListener = () => {}
const bridge = window.plusInstaller ?? {
  platform: 'win32',
  listDirectories: async (_target, path) => {
    const root = 'C:\\Users\\you'
    const current = path ?? root
    return { path: current, root, parent: current === root ? null : root, entries: ['DeepSeekHarnessPlus', 'Projects', '.config'].map(name => ({ name, path: current + '\\' + name, hidden: name.startsWith('.') })) }
  },
  createDirectory: async (_target, path, name) => path + '\\' + name,
  selectDirectory: async (_target, path) => path,
  listWslDistributions: async () => ['Ubuntu-24.04', 'Ubuntu', 'Debian'],
  install: async () => { progressListener({ message: text('progress.preparing') }); await new Promise(resolve => setTimeout(resolve, 700)); progressListener({ message: text('progress.preview') }) },
  applyAppearance: async () => undefined,
  onProgress: listener => { progressListener = listener },
}

const panels = [...document.querySelectorAll('.panel')]
const stepButtons = [...document.querySelectorAll('[data-step-target]')]
const stepLines = [...document.querySelectorAll('.stepper i')]
const back = document.querySelector('#back')
const next = document.querySelector('#next')
const error = document.querySelector('#error')
const progress = document.querySelector('#progress')
const progressText = document.querySelector('#progressText')
const summary = document.querySelector('#summary')
const reasoning = document.querySelector('#reasoningEffort')
const provider = document.querySelector('#provider')
const customProvider = document.querySelector('#customProvider')
const installPath = document.querySelector('#installPath')
const chooseDirectory = document.querySelector('#chooseDirectory')
const directoryBrowser = document.querySelector('#directoryBrowser')
const directoryPath = document.querySelector('#directoryPath')
const directoryList = document.querySelector('#directoryList')
const directoryBrowserError = document.querySelector('#directoryBrowserError')
const directoryUp = document.querySelector('#directoryUp')
const directoryPathEdit = document.querySelector('#directoryPathEdit')
const directoryNewFolder = document.querySelector('#directoryNewFolder')
const directoryCreate = document.querySelector('#directoryCreate')
const directoryNewName = document.querySelector('#directoryNewName')
const directoryCreateConfirm = document.querySelector('#directoryCreateConfirm')
const directoryCreateCancel = document.querySelector('#directoryCreateCancel')
const directoryShowHiddenToggle = document.querySelector('#directoryShowHidden')
const directoryCancel = document.querySelector('#directoryCancel')
const directoryOpen = document.querySelector('#directoryOpen')
const customName = document.querySelector('#customName')
const baseURL = document.querySelector('#baseURL')
const customProviderError = document.querySelector('#customProviderError')
const wslOptions = document.querySelector('#wslOptions')
const wslDistribution = document.querySelector('#wslDistribution')
const nativeTarget = document.querySelector('[data-target-kind="native"]')
const wslTarget = document.querySelector('[data-target-kind="wsl"]')
const sendWindowControl = window.plusInstaller?.windowControl
const selectControls = new Map()
const iconNamespace = 'http://www.w3.org/2000/svg'
const chevronPath = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z'
const checkPath = 'M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z'

function createIcon(path, viewBox, className) {
  const icon = document.createElementNS(iconNamespace, 'svg')
  icon.setAttribute('viewBox', viewBox)
  icon.setAttribute('fill', 'none')
  icon.setAttribute('aria-hidden', 'true')
  icon.classList.add(className)
  const shape = document.createElementNS(iconNamespace, 'path')
  shape.setAttribute('d', path)
  shape.setAttribute('fill', 'currentColor')
  icon.append(shape)
  return icon
}

const chevronLeftPath = 'M8.5 2.15137L8.07617 2.57617L5.34863 5.30273C5.09294 5.55843 4.86618 5.78438 4.70215 5.98828C4.53117 6.20088 4.38244 6.44405 4.33398 6.75C4.30778 6.91565 4.30778 7.08435 4.33398 7.25C4.38244 7.55595 4.53117 7.79912 4.70215 8.01172C4.86618 8.21561 5.09294 8.44157 5.34863 8.69727L8.07617 11.4238L8.5 11.8486L9.34863 11L8.92383 10.5762L6.19727 7.84863C5.92268 7.57405 5.75151 7.40124 5.6377 7.25977C5.53096 7.12709 5.52187 7.07728 5.51953 7.0625C5.51297 7.02105 5.51297 6.97895 5.51953 6.9375C5.52187 6.92272 5.53096 6.87291 5.6377 6.74023C5.75152 6.59876 5.92268 6.42595 6.19727 6.15137L8.92383 3.42383L9.34863 3L8.5 2.15137Z'
const chevronRightPath = 'M5.5 2.15137L5.92383 2.57617L8.65137 5.30273C8.90706 5.55843 9.13382 5.78438 9.29785 5.98828C9.46883 6.20088 9.61756 6.44405 9.66602 6.75C9.69222 6.91565 9.69222 7.08435 9.66602 7.25C9.61756 7.55595 9.46883 7.79912 9.29785 8.01172C9.13382 8.21561 8.90706 8.44157 8.65137 8.69727L5.92383 11.4238L5.5 11.8486L4.65137 11L5.07617 10.5762L7.80273 7.84863C8.07732 7.57405 8.24849 7.40124 8.3623 7.25977C8.46904 7.12709 8.47813 7.07728 8.48047 7.0625C8.48703 7.02105 8.48703 6.97895 8.48047 6.9375C8.47813 6.92272 8.46904 6.87291 8.3623 6.74023C8.24848 6.59876 8.07732 6.42595 7.80273 6.15137L5.07617 3.42383L4.65137 3L5.5 2.15137Z'
const plusPath = 'M8.64453 1.5V7.34961H14.5V8.65039H8.64453V14.5H7.34473V8.65039H1.5V7.34961H7.34473V1.5H8.64453Z'
const editPath = 'M9.94076 1.34942C10.7047 0.90231 11.6503 0.902415 12.4143 1.34942C12.7061 1.52015 12.9688 1.79118 13.3104 2.13284C13.6521 2.47448 13.9231 2.73721 14.0939 3.02894C14.5408 3.79294 14.5409 4.73856 14.0939 5.50251C13.9231 5.79415 13.652 6.05704 13.3104 6.39861L6.65932 13.0497C6.28068 13.4284 6.00695 13.7108 5.66543 13.9097C5.32391 14.1085 4.94315 14.2074 4.42705 14.3498L3.24394 14.6761C2.77527 14.8054 2.34538 14.9262 2.00131 14.9684C1.65196 15.0112 1.17964 15.0013 0.810764 14.6325C0.441921 14.2637 0.432107 13.7913 0.47486 13.442C0.517035 13.0979 0.6379 12.668 0.767181 12.1993L1.09352 11.0162C1.23588 10.5001 1.33481 10.1193 1.5336 9.77784C1.7325 9.43632 2.0149 9.1626 2.39355 8.78395L9.04466 2.13284C9.38625 1.79126 9.64911 1.52016 9.94076 1.34942ZM15.5427 14.8398H7.55223L8.96707 13.425H15.5427V14.8398ZM3.39382 9.78422C2.965 10.213 2.84244 10.3436 2.75709 10.49C2.67183 10.6366 2.61862 10.8079 2.45733 11.3925L2.13099 12.5756C2.00183 13.0439 1.92194 13.3419 1.88863 13.5536C2.10041 13.5204 2.39872 13.4416 2.86764 13.3123L4.05075 12.9859C4.63544 12.8246 4.80669 12.7715 4.95323 12.6862C5.09968 12.6008 5.23022 12.4783 5.65905 12.0494L10.721 6.98644L8.45577 4.72121L3.39382 9.78422ZM11.7 2.57079C11.3774 2.38198 10.9777 2.38198 10.6551 2.57079C10.5602 2.62647 10.4487 2.72931 10.0449 3.13311L9.45604 3.72094L11.7213 5.98617L12.3102 5.39833C12.7139 4.99457 12.8168 4.88307 12.8725 4.78818C13.0613 4.46561 13.0612 4.06585 12.8725 3.74326C12.8169 3.64827 12.7146 3.53752 12.3102 3.13311C11.9057 2.72863 11.795 2.6264 11.7 2.57079Z'
const folderPath = 'M5.19629 1.57104C5.81144 1.5711 6.38623 1.8786 6.72754 2.39038L7.19922 3.09839C7.28454 3.22635 7.42824 3.30344 7.58203 3.30347H12.1699C13.5039 3.30348 14.5859 4.38548 14.5859 5.71948V6.62671C15.2694 7.02689 15.6605 7.85012 15.4385 8.68726L14.3848 12.658C14.1037 13.7164 13.1449 14.4527 12.0498 14.4529H2.91699C1.51651 14.4529 0.451662 13.2814 0.501954 11.9519V3.98706C0.501954 2.65305 1.58396 1.57104 2.91797 1.57104H5.19629Z'

/** 用 Harness surface 渲染原生 select 的选项和选中态，原生字段仍是唯一值来源。 */
function syncSelectControl(select) {
  const control = selectControls.get(select)
  if (control === undefined) return
  const selected = [...select.options].find(option => option.value === select.value)
  control.value.textContent = selected?.textContent ?? ''
  control.trigger.setAttribute('aria-expanded', String(control.root.classList.contains('open')))
  control.menu.replaceChildren(...[...select.options].map(option => {
    const choice = document.createElement('button')
    choice.type = 'button'
    choice.className = 'select-option'
    choice.setAttribute('role', 'option')
    const isSelected = option.value === select.value
    choice.setAttribute('aria-selected', String(isSelected))
    const label = document.createElement('span')
    label.textContent = option.textContent
    const check = createIcon(checkPath, '0 0 16 16', 'select-check')
    check.toggleAttribute('hidden', !isSelected)
    choice.append(label, check)
    choice.addEventListener('click', () => {
      select.value = option.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
      control.root.classList.remove('open')
      syncSelectControl(select)
      control.trigger.focus()
    })
    return choice
  }))
}

function closeSelectControls(except) {
  selectControls.forEach((control, select) => {
    if (select === except) return
    control.root.classList.remove('open')
    syncSelectControl(select)
  })
}

/** 将一个安装器 select 变为带键盘操作的 Harness 选择控件。 */
function enhanceSelect(select) {
  const root = document.createElement('div')
  root.className = 'select-control'
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'select-trigger'
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.setAttribute('aria-label', select.labels[0]?.textContent?.trim() ?? '')
  const value = document.createElement('span')
  value.className = 'select-value'
  const chevron = createIcon(chevronPath, '0 0 14 14', 'select-chevron')
  trigger.append(value, chevron)
  const menu = document.createElement('div')
  menu.className = 'select-menu'
  menu.setAttribute('role', 'listbox')
  select.before(root)
  root.append(select, trigger, menu)
  select.classList.add('select-native')
  select.tabIndex = -1
  select.setAttribute('aria-hidden', 'true')
  selectControls.set(select, { root, trigger, value, chevron, menu })
  trigger.addEventListener('click', () => {
    const open = !root.classList.contains('open')
    closeSelectControls(select)
    root.classList.toggle('open', open)
    syncSelectControl(select)
  })
  trigger.addEventListener('keydown', event => {
    if (event.key === 'Escape') { root.classList.remove('open'); syncSelectControl(select); return }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); trigger.click(); return }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const index = [...select.options].findIndex(option => option.selected)
    const next = (index + (event.key === 'ArrowDown' ? 1 : select.options.length - 1)) % select.options.length
    select.value = select.options[next].value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  select.addEventListener('change', () => syncSelectControl(select))
  syncSelectControl(select)
}

[provider, reasoning, wslDistribution].forEach(enhanceSelect)
document.addEventListener('pointerdown', event => { if (![...selectControls.values()].some(control => control.root.contains(event.target))) closeSelectControls() })
document.addEventListener('keydown', event => { if (event.key !== 'Escape') return; if (!directoryBrowser.hidden) closeDirectoryBrowser(); else closeSelectControls() })

let step = Number(params.get('step') ?? 0)
let locale = params.get('locale') === 'en' ? 'en' : 'zh'
let theme = ['light', 'dark', 'system'].includes(params.get('theme')) ? params.get('theme') : 'system'
let targetKind = params.get('target') === 'wsl' ? 'wsl' : 'native'
let distributionsLoaded = false

function text(key) { return messages[locale][key] ?? key }
function resolvedTheme() { return theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : theme }
function target() { return { kind: targetKind, distribution: targetKind === 'wsl' ? wslDistribution.value : undefined } }
function nativeTargetName() { return bridge.platform === 'darwin' ? text('target.macos') : bridge.platform === 'linux' ? text('target.linux') : text('target.windows') }
function values() {
  return {
    installPath: installPath.value.trim(), port: document.querySelector('#port').value.trim(), apiKey: document.querySelector('#apiKey').value.trim(),
    provider: provider.value, model: document.querySelector('#model').value.trim(), reasoningEffort: reasoning.value,
    customName: document.querySelector('#customName').value.trim(), baseURL: document.querySelector('#baseURL').value.trim(), locale, theme, target: target(),
  }
}

function renderReasoningOptions() {
  const selected = reasoning.value
  reasoning.replaceChildren(...[['', 'reasoning.default'], ['low', 'reasoning.low'], ['medium', 'reasoning.medium'], ['high', 'reasoning.high'], ['max', 'reasoning.max']].map(([value, key]) => {
    const option = document.createElement('option'); option.value = value; option.textContent = text(key); return option
  }))
  reasoning.value = selected
  syncSelectControl(reasoning)
}
function renderProviderOptions() {
  const selected = provider.value || 'deepseek-official'
  provider.replaceChildren(...providerIds.map(id => {
    const option = document.createElement('option'); option.value = id; option.textContent = text('provider.' + id); return option
  }))
  provider.value = providerIds.includes(selected) ? selected : 'deepseek-official'
  syncSelectControl(provider)
}
function renderProvider() {
  customProvider.hidden = provider.value !== 'custom'
  if (provider.value !== 'custom') clearCustomProviderError()
}
function clearCustomProviderError() {
  customName.removeAttribute('aria-invalid')
  baseURL.removeAttribute('aria-invalid')
  customProviderError.hidden = true
  customProviderError.textContent = ''
}
function validateCustomProvider(config) {
  clearCustomProviderError()
  const invalid = (input, message) => {
    input.setAttribute('aria-invalid', 'true')
    customProviderError.textContent = message
    customProviderError.hidden = false
    input.focus()
    return message
  }
  if (!config.customName) return invalid(customName, text('error.customName'))
  if (!config.baseURL) return invalid(baseURL, text('error.customURL'))
  try {
    const url = new URL(config.baseURL)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return invalid(baseURL, text('error.customURLFormat'))
  } catch {
    return invalid(baseURL, text('error.customURLFormat'))
  }
  return ''
}
function renderTarget() {
  document.querySelectorAll('[data-target-kind]').forEach(button => {
    const selected = button.dataset.targetKind === targetKind
    button.classList.toggle('selected', selected)
    button.setAttribute('aria-checked', String(selected))
  })
  wslTarget.hidden = bridge.platform !== 'win32'
  nativeTarget.querySelector('.target-icon').textContent = bridge.platform === 'darwin' ? 'M' : bridge.platform === 'linux' ? 'L' : 'W'
  nativeTarget.querySelector('strong').textContent = nativeTargetName()
  wslOptions.hidden = targetKind !== 'wsl'
  installPath.placeholder = targetKind === 'wsl' ? '/home/you/deepseek-harness-plus' : 'C:\Users\you\DeepSeekHarnessPlus'
}
function applyAppearance() {
  const actualTheme = resolvedTheme()
  document.body.dataset.theme = actualTheme
  document.documentElement.style.colorScheme = actualTheme
  document.documentElement.lang = locale
  document.title = text('window.title')
  document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = text(node.dataset.i18n) })
  document.querySelectorAll('[data-i18n-placeholder]').forEach(node => { node.placeholder = text(node.dataset.i18nPlaceholder) })
  document.querySelectorAll('[data-i18n-title]').forEach(node => { const label = text(node.dataset.i18nTitle); node.title = label; node.setAttribute('aria-label', label) })
  document.querySelector('#stepper').setAttribute('aria-label', locale === 'zh' ? '安装进度' : 'Installation progress')
  document.querySelector('#localeControl').setAttribute('aria-label', text('label.language'))
  document.querySelector('#themeControl').setAttribute('aria-label', text('label.theme'))
  document.querySelector('#targetControl').setAttribute('aria-label', text('step.location'))
  document.querySelectorAll('[data-window-action]').forEach(button => button.setAttribute('aria-label', text('window.' + button.dataset.windowAction)))
  document.querySelectorAll('[data-locale]').forEach(button => { const selected = button.dataset.locale === locale; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)) })
  document.querySelectorAll('[data-theme]').forEach(button => { const selected = button.dataset.theme === theme; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)) })
  renderReasoningOptions(); renderProviderOptions(); renderProvider(); renderTarget(); showStep(step)
  void bridge.applyAppearance({ theme, locale, resolvedTheme: actualTheme, title: text('window.title') })
}
async function loadDistributions() {
  if (targetKind !== 'wsl') return
  progress.hidden = false; progressText.textContent = text('progress.distributions'); error.textContent = ''
  try {
    const selected = wslDistribution.value
    const distributions = await bridge.listWslDistributions()
    wslDistribution.replaceChildren(...distributions.map(name => { const option = document.createElement('option'); option.value = name; option.textContent = name; return option }))
    if (distributions.includes(selected)) wslDistribution.value = selected
    syncSelectControl(wslDistribution)
    distributionsLoaded = true
    if (distributions.length === 0) error.textContent = text('error.distributions')
  } catch (caught) {
    error.textContent = caught instanceof Error ? caught.message : String(caught)
  } finally { progress.hidden = true }
}
function addSummary(name, value) {
  const row = document.createElement('div'); const term = document.createElement('dt'); const description = document.createElement('dd')
  term.textContent = name; description.textContent = value; row.append(term, description); return row
}
function providerName(config) { return config.provider === 'custom' ? config.customName : text('provider.' + config.provider) }
function renderSummary() {
  const config = values()
  const rows = [
    addSummary(text('summary.language'), locale === 'zh' ? '中文' : 'English'),
    addSummary(text('summary.theme'), text('theme.' + theme)),
    addSummary(text('summary.location'), targetKind === 'wsl' ? 'Linux (WSL)' : nativeTargetName()),
  ]
  if (targetKind === 'wsl') rows.push(addSummary(text('summary.distribution'), config.target.distribution))
  rows.push(addSummary(text('summary.folder'), config.installPath), addSummary(text('summary.provider'), providerName(config)))
  if (config.provider === 'custom') rows.push(addSummary(text('summary.url'), config.baseURL))
  rows.push(addSummary(text('summary.model'), config.model))
  if (config.reasoningEffort) rows.push(addSummary(text('summary.reasoning'), text('reasoning.' + config.reasoningEffort)))
  summary.replaceChildren(...rows)
}
let directoryListing
let directorySelectedPath
let directoryTarget
let showHiddenDirectories = false
let directoryBusy = false

function renderDirectoryList() {
  directoryList.replaceChildren()
  const entries = directoryListing?.entries.filter(entry => showHiddenDirectories || !entry.hidden) ?? []
  if (entries.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'directory-empty'
    empty.textContent = text('directory.empty')
    directoryList.append(empty)
    return
  }
  entries.forEach(entry => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'directory-row'
    row.setAttribute('role', 'listitem')
    row.classList.toggle('selected', entry.path === directorySelectedPath)
    row.append(createIcon(folderPath, '0 0 16 16', 'directory-folder'))
    const label = document.createElement('span')
    label.textContent = entry.name
    const chevron = createIcon(chevronRightPath, '0 0 14 14', 'directory-chevron')
    row.append(label, chevron)
    row.addEventListener('click', () => { directorySelectedPath = entry.path; renderDirectoryList() })
    row.addEventListener('dblclick', () => { void loadDirectory(entry.path) })
    directoryList.append(row)
  })
}

function syncHiddenDirectoryToggle() {
  directoryShowHiddenToggle.setAttribute('aria-pressed', String(showHiddenDirectories))
}

async function loadDirectory(path) {
  directoryBusy = true
  directoryList.setAttribute('aria-busy', 'true')
  directoryBrowserError.hidden = true
  try {
    directoryListing = await bridge.listDirectories(directoryTarget, path)
    directorySelectedPath = undefined
    directoryPath.value = directoryListing.path
    directoryUp.disabled = directoryListing.parent === null
    renderDirectoryList()
  } catch (caught) {
    directoryBrowserError.textContent = caught instanceof Error ? caught.message : String(caught)
    directoryBrowserError.hidden = false
  } finally {
    directoryBusy = false
    directoryList.setAttribute('aria-busy', 'false')
  }
}

function closeDirectoryBrowser() {
  directoryBrowser.hidden = true
  directoryCreate.hidden = true
  directoryNewName.value = ''
  directoryListing = undefined
  directorySelectedPath = undefined
  directoryTarget = undefined
  directoryBrowserError.hidden = true
}

async function openDirectoryBrowser() {
  directoryTarget = target()
  showHiddenDirectories = false
  syncHiddenDirectoryToggle()
  directoryBrowser.hidden = false
  directoryPath.value = ''
  await loadDirectory()
}

async function confirmDirectoryBrowser() {
  if (directoryBusy || directoryListing === undefined) return
  try {
    const selected = directorySelectedPath ?? directoryListing.path
    installPath.value = await bridge.selectDirectory(directoryTarget, selected)
    closeDirectoryBrowser()
  } catch (caught) {
    directoryBrowserError.textContent = caught instanceof Error ? caught.message : String(caught)
    directoryBrowserError.hidden = false
  }
}

async function createDirectoryFromBrowser() {
  if (directoryBusy || directoryListing === undefined || !directoryNewName.value.trim()) return
  try {
    const parent = directoryListing.path
    const created = await bridge.createDirectory(directoryTarget, parent, directoryNewName.value)
    directoryCreate.hidden = true
    directoryNewName.value = ''
    await loadDirectory(parent)
    directorySelectedPath = created
    renderDirectoryList()
  } catch (caught) {
    directoryBrowserError.textContent = caught instanceof Error ? caught.message : String(caught)
    directoryBrowserError.hidden = false
  }
}

function showStep(nextStep) {
  step = Math.max(0, Math.min(3, nextStep))
  panels.forEach((panel, index) => panel.classList.toggle('active', index === step))
  stepButtons.forEach((button, index) => { button.classList.toggle('active', index === step); button.classList.toggle('complete', index < step); button.setAttribute('aria-current', index === step ? 'step' : 'false') })
  stepLines.forEach((line, index) => line.classList.toggle('complete', index < step))
  back.hidden = step === 0; next.textContent = step === 3 ? text('action.install') : text('action.continue'); error.textContent = ''; clearCustomProviderError()
  if (step === 3) renderSummary()
}
function validate() {
  const config = values()
  if (step === 1 && targetKind === 'wsl' && (!distributionsLoaded || !config.target.distribution)) return text('error.distribution')
  if (step === 1 && !config.installPath) return text('error.location')
  if (step === 1 && ['3081', '3082', '3083'].includes(config.port)) return text('error.reservedPort')
  if (step === 2 && (!config.apiKey || !config.model)) return text('error.model')
  if (step === 2 && config.provider === 'custom') return validateCustomProvider(config)
  return ''
}

document.querySelectorAll('[data-locale]').forEach(button => button.addEventListener('click', () => { locale = button.dataset.locale; applyAppearance() }))
async function handleWindowControl(command) {
  if (sendWindowControl === undefined) return
  try {
    const result = await sendWindowControl(command)
    if (command === 'toggle-maximize') {
      const maximized = Boolean(result?.maximized)
      const control = document.querySelector('#toggleMaximize')
      control.dataset.maximized = String(maximized)
      control.setAttribute('aria-pressed', String(maximized))
      control.setAttribute('aria-label', text(maximized ? 'window.restore' : 'window.maximize'))
    }
  } catch (caught) { error.textContent = caught instanceof Error ? caught.message : String(caught) }
}
function bindWindowControl(selector, command) {
  const control = document.querySelector(selector)
  control.addEventListener('pointerdown', event => { event.stopPropagation(); void handleWindowControl(command) })
  control.addEventListener('click', event => { if (event.detail === 0) void handleWindowControl(command) })
}
bindWindowControl('#minimizeWindow', 'minimize')
bindWindowControl('#toggleMaximize', 'toggle-maximize')
bindWindowControl('#closeWindow', 'close')
document.querySelectorAll('[data-theme]').forEach(button => button.addEventListener('click', () => { theme = button.dataset.theme; applyAppearance() }))
document.querySelectorAll('[data-target-kind]').forEach(button => button.addEventListener('click', async () => {
  targetKind = button.dataset.targetKind; distributionsLoaded = false; installPath.value = ''; renderTarget(); if (targetKind === 'wsl') await loadDistributions()
}))
provider.addEventListener('change', () => { document.querySelector('#model').value = providerDefaults[provider.value]; renderProvider() })
stepButtons.forEach(button => button.addEventListener('click', () => { const targetStep = Number(button.dataset.stepTarget); if (targetStep <= step) showStep(targetStep) }))
directoryUp.append(createIcon(chevronLeftPath, '0 0 14 14', 'directory-up-icon'))
directoryPathEdit.append(createIcon(editPath, '0 0 16 16', 'directory-edit-icon'))
directoryNewFolder.prepend(createIcon(plusPath, '0 0 16 16', 'directory-new-icon'))

chooseDirectory.addEventListener('click', () => { void openDirectoryBrowser() })
directoryCancel.addEventListener('click', closeDirectoryBrowser)
directoryBrowser.addEventListener('pointerdown', event => { if (event.target === directoryBrowser) closeDirectoryBrowser() })
directoryUp.addEventListener('click', () => { if (directoryListing?.parent) void loadDirectory(directoryListing.parent) })
directoryPathEdit.addEventListener('click', () => directoryPath.focus())
directoryPath.addEventListener('keydown', event => { if (event.key === 'Enter' && directoryPath.value.trim()) { event.preventDefault(); void loadDirectory(directoryPath.value.trim()) } })
directoryShowHiddenToggle.addEventListener('click', () => { showHiddenDirectories = !showHiddenDirectories; syncHiddenDirectoryToggle(); renderDirectoryList() })
directoryNewFolder.addEventListener('click', () => { directoryCreate.hidden = false; directoryNewName.focus() })
directoryCreateCancel.addEventListener('click', () => { directoryCreate.hidden = true; directoryNewName.value = '' })
directoryCreateConfirm.addEventListener('click', () => { void createDirectoryFromBrowser() })
directoryNewName.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void createDirectoryFromBrowser() } })
directoryOpen.addEventListener('click', () => { void confirmDirectoryBrowser() })
customName.addEventListener('input', clearCustomProviderError)
baseURL.addEventListener('input', clearCustomProviderError)
document.querySelector('#refreshDistributions').addEventListener('click', loadDistributions)
back.addEventListener('click', () => showStep(step - 1))
next.addEventListener('click', async () => {
  const message = validate(); if (message) { error.textContent = message; return }
  if (step < 3) { showStep(step + 1); return }
  next.disabled = true; back.disabled = true; progress.hidden = false; progressText.textContent = text('progress.preparing')
  try { await bridge.install(values()); if (preview) { next.disabled = false; back.disabled = false } }
  catch (caught) { error.textContent = caught instanceof Error ? caught.message : String(caught); next.disabled = false; back.disabled = false; progress.hidden = true }
})
bridge.onProgress(({ message }) => { progress.hidden = false; progressText.textContent = message })
systemDark.addEventListener('change', () => { if (theme === 'system') applyAppearance() })
if (preview) { document.querySelector('#apiKey').value = 'sk-preview'; installPath.value = targetKind === 'wsl' ? '/home/you/deepseek-harness-plus' : 'C:\Users\you\DeepSeekHarnessPlus' }
applyAppearance()
if (targetKind === 'wsl') void loadDistributions()
