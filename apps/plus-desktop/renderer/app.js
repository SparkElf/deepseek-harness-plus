const messages = {
  zh: {
    'brand.setup': '安装', 'window.minimize': '最小化', 'window.maximize': '最大化', 'window.close': '关闭',
    'step.appearance': '外观', 'step.environment': '运行环境', 'step.runtime': '安装位置', 'step.model': '模型', 'step.review': '确认',
    'eyebrow.initial': '初始设置', 'eyebrow.environment': '运行方式', 'eyebrow.runtime': '本地运行', 'eyebrow.model': '初始模型', 'eyebrow.review': '准备安装',
    'title.appearance': '选择界面外观', 'title.environment': '选择运行环境', 'title.runtime': '选择安装位置', 'title.model': '连接 DeepSeek', 'title.review': '确认初始设置',
    'intro.appearance': '这些选择会立即应用，并成为 Harness 的默认界面设置。',
    'intro.environment': '选择 Harness 实际安装和运行的位置。',
    'intro.runtime': 'Plus 会在所选环境中准备独立的 Harness 运行目录。',
    'intro.model': '完成安装后，可以继续在 Harness 设置中管理模型与凭据。',
    'intro.review': '确认后将准备本地运行环境并打开 Harness。',
    'label.language': '默认语言', 'help.language': '安装向导和 Harness 使用相同语言。',
    'label.theme': '默认主题', 'help.theme': '选择后即可预览整个安装界面。',
    'theme.system': '跟随系统', 'theme.light': '浅色', 'theme.dark': '深色',
    'target.windows': 'Windows', 'target.linux': 'Linux', 'target.macos': 'macOS', 'target.windowsHelp': '直接安装到 Windows 文件系统', 'target.nativeHelp': '安装到本机文件系统', 'target.wslHelp': '安装到选定的 Linux 发行版',
    'label.distribution': 'WSL 发行版', 'help.distribution': 'Harness 的依赖、构建和运行都在此发行版内完成。',
    'label.installPath': '安装目录', 'label.port': '正式 Harness 端口', 'help.port': '建议使用 3080；3081 至 3083 保留给测试版 Harness 与 Supervisor。', 'label.apiKey': 'DeepSeek API 密钥',
    'label.model': '默认模型', 'label.reasoning': '推理强度',
    'action.choose': '选择', 'action.refresh': '刷新', 'action.back': '返回', 'action.continue': '继续', 'action.install': '安装 Plus',
    'reasoning.default': '提供方默认', 'reasoning.low': '低', 'reasoning.medium': '中', 'reasoning.high': '高', 'reasoning.max': '最高',
    'summary.language': '语言', 'summary.theme': '主题', 'summary.environment': '运行环境', 'summary.distribution': 'WSL 发行版',
    'summary.installPath': '安装目录', 'summary.provider': '提供方', 'summary.model': '默认模型', 'summary.reasoning': '推理强度', 'summary.port': '正式端口',
    'error.environment': '请选择运行环境；使用 WSL 时还要选择发行版。', 'error.runtime': '请选择安装目录并填写正式 Harness 端口。', 'error.reservedPort': '3081 至 3083 已保留，请选择其他端口。',
    'error.model': '请输入 DeepSeek API 密钥和默认模型。', 'error.distributions': '没有发现可用的 WSL 发行版。',
    'progress.distributions': '正在读取 WSL 发行版…', 'progress.preparing': '正在准备安装…', 'progress.preview': '预览完成，未写入任何文件。',
    'window.title': '安装 DeepSeek Harness Plus',
  },
  en: {
    'brand.setup': 'Setup', 'window.minimize': 'Minimize', 'window.maximize': 'Maximize', 'window.close': 'Close',
    'step.appearance': 'Appearance', 'step.environment': 'Environment', 'step.runtime': 'Location', 'step.model': 'Model', 'step.review': 'Review',
    'eyebrow.initial': 'Initial setup', 'eyebrow.environment': 'Runtime target', 'eyebrow.runtime': 'Local runtime', 'eyebrow.model': 'Initial model', 'eyebrow.review': 'Ready to install',
    'title.appearance': 'Choose the interface', 'title.environment': 'Choose the runtime environment', 'title.runtime': 'Choose the install location', 'title.model': 'Connect DeepSeek', 'title.review': 'Review the initial setup',
    'intro.appearance': 'These choices apply immediately and become the Harness defaults.',
    'intro.environment': 'Choose where Harness is installed and runs.',
    'intro.runtime': 'Plus prepares an independent Harness runtime in the selected environment.',
    'intro.model': 'After installation, continue managing models and credentials in Harness settings.',
    'intro.review': 'Plus will prepare the local runtime and open Harness after confirmation.',
    'label.language': 'Default language', 'help.language': 'The installer and Harness use the same language.',
    'label.theme': 'Default theme', 'help.theme': 'Preview the entire installer as soon as you select it.',
    'theme.system': 'System', 'theme.light': 'Light', 'theme.dark': 'Dark',
    'target.windows': 'Windows', 'target.linux': 'Linux', 'target.macos': 'macOS', 'target.windowsHelp': 'Install directly in the Windows filesystem', 'target.nativeHelp': 'Install in the local filesystem', 'target.wslHelp': 'Install inside a selected Linux distribution',
    'label.distribution': 'WSL distribution', 'help.distribution': 'Harness dependencies, builds, and processes stay inside this distribution.',
    'label.installPath': 'Installation folder', 'label.port': 'Production Harness port', 'help.port': 'Use 3080 by default; 3081 through 3083 are reserved for candidate Harness and Supervisor.', 'label.apiKey': 'DeepSeek API key',
    'label.model': 'Default model', 'label.reasoning': 'Reasoning effort',
    'action.choose': 'Choose', 'action.refresh': 'Refresh', 'action.back': 'Back', 'action.continue': 'Continue', 'action.install': 'Install Plus',
    'reasoning.default': 'Provider default', 'reasoning.low': 'Low', 'reasoning.medium': 'Medium', 'reasoning.high': 'High', 'reasoning.max': 'Max',
    'summary.language': 'Language', 'summary.theme': 'Theme', 'summary.environment': 'Runtime environment', 'summary.distribution': 'WSL distribution',
    'summary.installPath': 'Installation folder', 'summary.provider': 'Provider', 'summary.model': 'Default model', 'summary.reasoning': 'Reasoning effort', 'summary.port': 'Production port',
    'error.environment': 'Choose a runtime environment and a distribution when using WSL.', 'error.runtime': 'Choose an installation folder and production Harness port.', 'error.reservedPort': 'Ports 3081 through 3083 are reserved. Choose another port.',
    'error.model': 'Enter a DeepSeek API key and default model.', 'error.distributions': 'No available WSL distributions were found.',
    'progress.distributions': 'Loading WSL distributions…', 'progress.preparing': 'Preparing installation…', 'progress.preview': 'Preview complete. No files were written.',
    'window.title': 'Install DeepSeek Harness Plus',
  },
}

const params = new URLSearchParams(location.search)
const systemDark = matchMedia('(prefers-color-scheme: dark)')
const preview = window.plusInstaller === undefined
let progressListener = () => {}
const bridge = window.plusInstaller ?? {
  platform: 'win32',
  chooseDirectory: async target => target.kind === 'wsl' ? '/home/you/deepseek-harness-plus' : 'C:\Users\you\DeepSeekHarnessPlus',
  listWslDistributions: async () => ['Ubuntu-24.04', 'Ubuntu', 'Debian'],
  install: async () => {
    progressListener({ message: text('progress.preparing') })
    await new Promise(resolve => setTimeout(resolve, 700))
    progressListener({ message: text('progress.preview') })
  },
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
const installPath = document.querySelector('#installPath')
const chooseDirectory = document.querySelector('#chooseDirectory')
const windowControl = window.plusInstaller?.windowControl ?? (() => Promise.resolve())
const wslOptions = document.querySelector('#wslOptions')
const wslDistribution = document.querySelector('#wslDistribution')
const nativeTarget = document.querySelector('[data-target-kind="native"]')
const wslTarget = document.querySelector('[data-target-kind="wsl"]')
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
    installPath: installPath.value.trim(), port: document.querySelector('#port').value.trim(),
    apiKey: document.querySelector('#apiKey').value.trim(), model: document.querySelector('#model').value.trim(),
    reasoningEffort: reasoning.value, locale, theme, target: target(),
  }
}

function renderReasoningOptions() {
  const selected = reasoning.value
  reasoning.replaceChildren(...[['', 'reasoning.default'], ['low', 'reasoning.low'], ['medium', 'reasoning.medium'], ['high', 'reasoning.high'], ['max', 'reasoning.max']].map(([value, key]) => {
    const option = document.createElement('option'); option.value = value; option.textContent = text(key); return option
  }))
  reasoning.value = selected
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
  nativeTarget.querySelector('small').textContent = bridge.platform === 'win32' ? text('target.windowsHelp') : text('target.nativeHelp')
  wslOptions.hidden = targetKind !== 'wsl'
  chooseDirectory.hidden = targetKind === 'wsl'
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
  document.querySelectorAll('[data-window-action]').forEach(button => button.setAttribute('aria-label', text('window.' + button.dataset.windowAction)))
  document.querySelector('#targetControl').setAttribute('aria-label', text('step.environment'))
  document.querySelectorAll('[data-locale]').forEach(button => { const selected = button.dataset.locale === locale; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)) })
  document.querySelectorAll('[data-theme]').forEach(button => { const selected = button.dataset.theme === theme; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)) })
  renderReasoningOptions(); renderTarget(); showStep(step)
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
    distributionsLoaded = true
    if (distributions.length === 0) error.textContent = text('error.distributions')
    if (step === 4) renderSummary()
  } catch (caught) {
    error.textContent = caught instanceof Error ? caught.message : String(caught)
  } finally { progress.hidden = true }
}

function addSummary(name, value) {
  const row = document.createElement('div'); const term = document.createElement('dt'); const description = document.createElement('dd')
  term.textContent = name; description.textContent = value; row.append(term, description); return row
}
function renderSummary() {
  const config = values()
  const rows = [
    addSummary(text('summary.language'), locale === 'zh' ? '中文' : 'English'),
    addSummary(text('summary.theme'), text('theme.' + theme)),
    addSummary(text('summary.environment'), targetKind === 'wsl' ? 'WSL' : nativeTargetName()),
  ]
  if (targetKind === 'wsl') rows.push(addSummary(text('summary.distribution'), config.target.distribution))
  rows.push(addSummary(text('summary.installPath'), config.installPath), addSummary(text('summary.provider'), 'DeepSeek official'), addSummary(text('summary.model'), config.model), addSummary(text('summary.reasoning'), config.reasoningEffort ? text('reasoning.' + config.reasoningEffort) : text('reasoning.default')), addSummary(text('summary.port'), config.port))
  summary.replaceChildren(...rows)
}
function showStep(nextStep) {
  step = Math.max(0, Math.min(4, nextStep))
  panels.forEach((panel, index) => panel.classList.toggle('active', index === step))
  stepButtons.forEach((button, index) => { button.classList.toggle('active', index === step); button.classList.toggle('complete', index < step); button.setAttribute('aria-current', index === step ? 'step' : 'false') })
  stepLines.forEach((line, index) => line.classList.toggle('complete', index < step))
  back.hidden = step === 0; next.textContent = step === 4 ? text('action.install') : text('action.continue'); error.textContent = ''
  if (step === 4) renderSummary()
}
function validate() {
  const config = values()
  if (step === 1 && (targetKind === 'wsl' && (!distributionsLoaded || !config.target.distribution))) return text('error.environment')
  if (step === 2 && (!config.installPath || !config.port)) return text('error.runtime')
  if (step === 2 && ['3081', '3082', '3083'].includes(config.port)) return text('error.reservedPort')
  if (step === 3 && (!config.apiKey || !config.model)) return text('error.model')
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
stepButtons.forEach(button => button.addEventListener('click', () => { const targetStep = Number(button.dataset.stepTarget); if (targetStep <= step) showStep(targetStep) }))
chooseDirectory.addEventListener('click', async () => { const path = await bridge.chooseDirectory(target()); if (path) installPath.value = path })
document.querySelector('#refreshDistributions').addEventListener('click', loadDistributions)
back.addEventListener('click', () => showStep(step - 1))
next.addEventListener('click', async () => {
  const message = validate(); if (message) { error.textContent = message; return }
  if (step < 4) { showStep(step + 1); return }
  next.disabled = true; back.disabled = true; progress.hidden = false; progressText.textContent = text('progress.preparing')
  try { await bridge.install(values()); if (preview) { next.disabled = false; back.disabled = false } }
  catch (caught) { error.textContent = caught instanceof Error ? caught.message : String(caught); next.disabled = false; back.disabled = false; progress.hidden = true }
})
bridge.onProgress(({ message }) => { progress.hidden = false; progressText.textContent = message })
systemDark.addEventListener('change', () => { if (theme === 'system') applyAppearance() })
if (preview) { installPath.value = targetKind === 'wsl' ? '/home/you/deepseek-harness-plus' : 'C:\Users\you\DeepSeekHarnessPlus'; document.querySelector('#apiKey').value = 'sk-preview' }
applyAppearance()
if (targetKind === 'wsl') void loadDistributions()
