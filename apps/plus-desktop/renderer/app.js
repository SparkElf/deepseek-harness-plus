const panels = [...document.querySelectorAll('.panel')]
const steps = [...document.querySelectorAll('.steps li')]
const title = document.querySelector('#title')
const back = document.querySelector('#back')
const next = document.querySelector('#next')
const error = document.querySelector('#error')
const progress = document.querySelector('#progress')
const progressText = document.querySelector('#progressText')
const summary = document.querySelector('#summary')
let step = 0

const values = () => ({
  installPath: document.querySelector('#installPath').value.trim(),
  port: document.querySelector('#port').value.trim(),
  apiKey: document.querySelector('#apiKey').value.trim(),
  model: document.querySelector('#model').value.trim(),
  reasoningEffort: document.querySelector('#reasoningEffort').value,
})

function showStep(nextStep) {
  step = nextStep
  panels.forEach((panel, index) => panel.classList.toggle('active', index === step))
  steps.forEach((item, index) => item.classList.toggle('active', index === step))
  title.textContent = ['Choose a local installation', 'Set the initial default model', 'Review and install'][step]
  back.hidden = step === 0
  next.textContent = step === 2 ? 'Install Plus' : 'Continue'
  error.textContent = ''
  if (step === 2) {
    const config = values()
    summary.innerHTML = [
      ['Installation folder', config.installPath],
      ['Provider', 'DeepSeek official'],
      ['Default model', config.model],
      ['Reasoning effort', config.reasoningEffort || 'Provider default'],
      ['Local port', config.port],
    ].map(([name, value]) => '<div><dt>' + name + '</dt><dd>' + value + '</dd></div>').join('')
  }
}

function validate() {
  const config = values()
  if (step === 0 && (!config.installPath || !config.port)) return 'Choose an installation folder and local port.'
  if (step === 1 && (!config.apiKey || !config.model)) return 'Enter a DeepSeek API key and default model.'
  return ''
}

document.querySelector('#chooseDirectory').addEventListener('click', async () => {
  const path = await window.plusInstaller.chooseDirectory()
  if (path) document.querySelector('#installPath').value = path
})

back.addEventListener('click', () => showStep(step - 1))
next.addEventListener('click', async () => {
  const message = validate()
  if (message) {
    error.textContent = message
    return
  }
  if (step < 2) {
    showStep(step + 1)
    return
  }
  next.disabled = true
  back.disabled = true
  progress.hidden = false
  try {
    await window.plusInstaller.install(values())
  } catch (caught) {
    error.textContent = caught.message
    next.disabled = false
    back.disabled = false
    progress.hidden = true
  }
})

window.plusInstaller.onProgress(({ message }) => {
  progress.hidden = false
  progressText.textContent = message
})

showStep(0)
