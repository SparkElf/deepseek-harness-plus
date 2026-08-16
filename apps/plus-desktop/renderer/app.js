const messages = {
  zh: {
    'window.minimize': '最小化', 'window.maximize': '最大化', 'window.close': '关闭',
    'step.appearance': '外观', 'step.location': '安装位置', 'step.model': '模型', 'step.review': '确认',
    'title.appearance': '选择界面外观', 'title.location': '选择安装位置', 'title.model': '选择模型', 'title.review': '确认安装',
    'label.language': '语言', 'label.theme': '主题', 'label.distribution': '发行版', 'label.installPath': '安装目录', 'label.port': '端口',
    'label.provider': '模型提供方', 'label.apiKey': 'API 密钥', 'label.model': '模型名称', 'label.reasoning': '推理强度',
    'label.providerName': '服务名称', 'label.baseURL': '服务地址',
    'theme.system': '跟随系统', 'theme.light': '浅色', 'theme.dark': '深色',
    'target.windows': 'Windows', 'target.linux': 'Linux', 'target.macos': 'macOS',
    'provider.deepseek-official': 'DeepSeek', 'provider.openai': 'OpenAI', 'provider.anthropic': 'Anthropic', 'provider.google': 'Google',
    'provider.openrouter': 'OpenRouter', 'provider.groq': 'Groq', 'provider.mistral': 'Mistral', 'provider.xai': 'xAI', 'provider.custom': '自定义提供方',
    'action.choose': '选择文件夹', 'action.refresh': '刷新', 'action.back': '返回', 'action.continue': '继续', 'action.install': '安装',
    'advanced.title': '高级选项',
    'reasoning.default': '默认', 'reasoning.low': '低', 'reasoning.medium': '中', 'reasoning.high': '高', 'reasoning.max': '最高',
    'summary.language': '语言', 'summary.theme': '主题', 'summary.location': '安装位置', 'summary.distribution': '发行版',
    'summary.folder': '安装目录', 'summary.provider': '模型提供方', 'summary.url': '服务地址', 'summary.model': '模型', 'summary.reasoning': '推理强度', 'summary.port': '端口',
    'error.location': '请选择安装目录。', 'error.distribution': '请选择 WSL 发行版。', 'error.reservedPort': '该端口不可用，请选择其他端口。',
    'error.model': '请填写 API 密钥和模型名称。', 'error.customProvider': '请填写服务名称和服务地址。', 'error.distributions': '没有可用的 WSL 发行版。',
    'progress.distributions': '正在读取发行版…', 'progress.preparing': '正在开始安装…', 'progress.preview': '预览完成。',
    'window.title': '安装 DeepSeek Harness Plus',
  },
  en: {
    'window.minimize': 'Minimize', 'window.maximize': 'Maximize', 'window.close': 'Close',
    'step.appearance': 'Appearance', 'step.location': 'Location', 'step.model': 'Model', 'step.review': 'Review',
    'title.appearance': 'Choose the interface', 'title.location': 'Choose where to install', 'title.model': 'Choose a model', 'title.review': 'Ready to install',
    'label.language': 'Language', 'label.theme': 'Theme', 'label.distribution': 'Linux distribution', 'label.installPath': 'Installation folder', 'label.port': 'Port',
    'label.provider': 'Model provider', 'label.apiKey': 'API key', 'label.model': 'Model', 'label.reasoning': 'Reasoning',
    'label.providerName': 'Service name', 'label.baseURL': 'Service URL',
    'theme.system': 'System', 'theme.light': 'Light', 'theme.dark': 'Dark',
    'target.windows': 'Windows', 'target.linux': 'Linux', 'target.macos': 'macOS',
    'provider.deepseek-official': 'DeepSeek', 'provider.openai': 'OpenAI', 'provider.anthropic': 'Anthropic', 'provider.google': 'Google',
    'provider.openrouter': 'OpenRouter', 'provider.groq': 'Groq', 'provider.mistral': 'Mistral', 'provider.xai': 'xAI', 'provider.custom': 'Custom provider',
    'action.choose': 'Choose folder', 'action.refresh': 'Refresh', 'action.back': 'Back', 'action.continue': 'Continue', 'action.install': 'Install',
    'advanced.title': 'Advanced',
    'reasoning.default': 'Default', 'reasoning.low': 'Low', 'reasoning.medium': 'Medium', 'reasoning.high': 'High', 'reasoning.max': 'Max',
    'summary.language': 'Language', 'summary.theme': 'Theme', 'summary.location': 'Install location', 'summary.distribution': 'Linux distribution',
    'summary.folder': 'Installation folder', 'summary.provider': 'Model provider', 'summary.url': 'Service URL', 'summary.model': 'Model', 'summary.reasoning': 'Reasoning', 'summary.port': 'Port',
    'error.location': 'Choose an installation folder.', 'error.distribution': 'Choose a Linux distribution.', 'error.reservedPort': 'This port is unavailable. Choose another port.',
    'error.model': 'Enter an API key and model.', 'error.customProvider': 'Enter a service name and URL.', 'error.distributions': 'No Linux distributions are available.',
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
  chooseDirectory: async target => target.kind === 'wsl' ? '/home/you/deepseek-harness-plus' : 'C:\Users\you\DeepSeekHarnessPlus',
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
const wslOptions = document.querySelector('#wslOptions')
const wslDistribution = document.querySelector('#wslDistribution')
const nativeTarget = document.querySelector('[data-target-kind="native"]')
const wslTarget = document.querySelector('[data-target-kind="wsl"]')
const windowControl = window.plusInstaller?.windowControl ?? (() => Promise.resolve())
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
    check.hidden = !isSelected
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
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeSelectControls() })

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
function showStep(nextStep) {
  step = Math.max(0, Math.min(3, nextStep))
  panels.forEach((panel, index) => panel.classList.toggle('active', index === step))
  stepButtons.forEach((button, index) => { button.classList.toggle('active', index === step); button.classList.toggle('complete', index < step); button.setAttribute('aria-current', index === step ? 'step' : 'false') })
  stepLines.forEach((line, index) => line.classList.toggle('complete', index < step))
  back.hidden = step === 0; next.textContent = step === 3 ? text('action.install') : text('action.continue'); error.textContent = ''
  if (step === 3) renderSummary()
}
function validate() {
  const config = values()
  if (step === 1 && targetKind === 'wsl' && (!distributionsLoaded || !config.target.distribution)) return text('error.distribution')
  if (step === 1 && !config.installPath) return text('error.location')
  if (step === 1 && ['3081', '3082', '3083'].includes(config.port)) return text('error.reservedPort')
  if (step === 2 && (!config.apiKey || !config.model)) return text('error.model')
  if (step === 2 && config.provider === 'custom' && (!config.customName || !config.baseURL)) return text('error.customProvider')
  return ''
}

document.querySelectorAll('[data-locale]').forEach(button => button.addEventListener('click', () => { locale = button.dataset.locale; applyAppearance() }))
document.querySelector('#minimizeWindow').addEventListener('click', () => { void windowControl('minimize') })
document.querySelector('#toggleMaximize').addEventListener('click', () => { void windowControl('toggle-maximize') })
document.querySelector('#closeWindow').addEventListener('click', () => { void windowControl('close') })
document.querySelectorAll('[data-theme]').forEach(button => button.addEventListener('click', () => { theme = button.dataset.theme; applyAppearance() }))
document.querySelectorAll('[data-target-kind]').forEach(button => button.addEventListener('click', async () => {
  targetKind = button.dataset.targetKind; distributionsLoaded = false; installPath.value = ''; renderTarget(); if (targetKind === 'wsl') await loadDistributions()
}))
provider.addEventListener('change', () => { document.querySelector('#model').value = providerDefaults[provider.value]; renderProvider() })
stepButtons.forEach(button => button.addEventListener('click', () => { const targetStep = Number(button.dataset.stepTarget); if (targetStep <= step) showStep(targetStep) }))
chooseDirectory.addEventListener('click', async () => { const path = await bridge.chooseDirectory(target()); if (path) installPath.value = path })
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
