const form = document.querySelector('#setup-form')
const panels = [...document.querySelectorAll('.step-panel')]
const steps = [...document.querySelectorAll('.steps li')]
const title = document.querySelector('#title')
const back = document.querySelector('#back')
const next = document.querySelector('#next')
const error = document.querySelector('#error')
const progress = document.querySelector('#progress')
const progressText = document.querySelector('#progressText')
const summary = document.querySelector('#summary')
const service = document.querySelector('#service')
let step = 0
let installed = false

const fields = ['installPath', 'workspacePath', 'port', 'apiKey', 'model', 'reasoningEffort', 'startAfterInstall']
const values = () => Object.fromEntries(fields.map((id) => [id, document.querySelector('#' + id).type === 'checkbox' ? document.querySelector('#' + id).checked : document.querySelector('#' + id).value.trim()]))

function showStep(nextStep) {
  step = nextStep
  panels.forEach((panel, index) => panel.classList.toggle('active', index === step))
  steps.forEach((item, index) => item.classList.toggle('active', index === step))
  title.textContent = ['Set up your workspace', 'Choose your default model', 'Review and install'][step]
  back.hidden = step === 0
  next.textContent = step === 2 ? 'Install Plus' : 'Continue'
  error.textContent = ''
  if (step === 2) {
    const config = values()
    summary.innerHTML = [
      ['Installation folder', config.installPath], ['Workspace folder', config.workspacePath], ['Provider', 'DeepSeek official'], ['Default model', config.model], ['Local port', config.port], ['Start after install', config.startAfterInstall ? 'Yes' : 'No'],
    ].map(([name, value]) => '<div><dt>' + name + '</dt><dd>' + value + '</dd></div>').join('')
  }
}

function validate() {
  const config = values()
  if (step === 0 && (!config.installPath || !config.workspacePath || !config.port)) return 'Choose an installation folder, workspace folder, and local port.'
  if (step === 1 && (!config.apiKey || !config.model)) return 'Enter your DeepSeek API key and default model.'
  return ''
}

document.querySelectorAll('[data-directory]').forEach((button) => button.addEventListener('click', async () => {
  const path = await window.plusDesktop.chooseDirectory()
  if (path) document.querySelector('#' + button.dataset.directory).value = path
}))

back.addEventListener('click', () => showStep(step - 1))
next.addEventListener('click', async () => {
  if (installed) { await window.plusDesktop.open(); return }
  const message = validate()
  if (message) { error.textContent = message; return }
  if (step < 2) { showStep(step + 1); return }
  next.disabled = true
  back.disabled = true
  progress.hidden = false
  try {
    await window.plusDesktop.install(values())
    installed = true
    service.textContent = 'Setup complete'
    showStep(2)
    next.textContent = 'Open local UI'
    next.disabled = false
  } catch (caught) {
    error.textContent = caught.message
    next.disabled = false
    back.disabled = false
  } finally { progress.hidden = true }
})

window.plusDesktop.onProgress(({ message }) => { progress.hidden = false; progressText.textContent = message })
window.plusDesktop.onServiceStatus(({ state, message }) => { service.textContent = state === 'running' ? 'Service running' : state === 'error' ? 'Service needs attention' : 'Service stopped'; if (state === 'error') error.textContent = message })
window.plusDesktop.current().then(({ setup, service: current }) => {
  service.textContent = current === 'running' ? 'Service running' : 'Service stopped'
  if (!setup) return
  for (const [id, value] of Object.entries(setup)) {
    const input = document.querySelector('#' + id)
    if (!input || value === undefined) continue
    input.type === 'checkbox' ? input.checked = value : input.value = String(value)
  }
  installed = true
  showStep(2)
  next.textContent = 'Open local UI'
})
showStep(0)
