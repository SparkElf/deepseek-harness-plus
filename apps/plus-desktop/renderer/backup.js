const bridge = window.plusBackup
const status = document.querySelector('#status')
const error = document.querySelector('#error')
const exportButton = document.querySelector('#export')
const importButton = document.querySelector('#import')
let locale = 'zh'
let snapshot

function t(zh, en) { return locale === 'zh' ? zh : en }
function setBusy(message) { status.textContent = message; error.textContent = ''; exportButton.disabled = importButton.disabled = Boolean(message) }
function fail(caught) { status.textContent = ''; error.textContent = caught instanceof Error ? caught.message : String(caught); exportButton.disabled = importButton.disabled = false }

function render() {
  locale = snapshot.locale
  document.documentElement.lang = locale
  document.querySelector('#title').textContent = t('备份与恢复', 'Backup and restore')
  document.querySelector('#location').textContent = t('数据目录：', 'Data folder: ') + snapshot.dshHome
  document.querySelector('#export-title').textContent = t('导出用户设置和数据', 'Export user settings and data')
  document.querySelector('#import-title').textContent = t('导入用户设置和数据', 'Import user settings and data')
  document.querySelector('#export-desc').textContent = t('把当前设置（含 provider 和模型配置）、会话和凭据等用户数据导出为一个 zip 压缩包。', 'Export settings (including provider and model configuration), sessions, credentials and other user data as one zip archive.')
  document.querySelector('#import-desc').textContent = t('从备份压缩包恢复用户数据；同名文件会被覆盖，导入期间 Harness 会先停止、成功后自动重启。', 'Restore user data from a backup archive; same-named files are replaced. Harness stops during import and restarts after success.')
  document.querySelector('#warning').textContent = t('备份压缩包包含 API 密钥等敏感信息，请妥善保管。', 'The backup archive contains sensitive data such as API keys; store it carefully.')
  exportButton.textContent = t('导出备份压缩包', 'Export backup archive')
  importButton.textContent = t('选择压缩包并导入', 'Choose archive and import')
}

exportButton.addEventListener('click', () => {
  void (async () => {
    setBusy(t('正在导出备份…', 'Exporting backup…'))
    try {
      const result = await bridge.exportArchive()
      if (result.canceled) { setBusy(''); return }
      status.textContent = t('备份已导出（' + String(result.entries) + ' 个条目）：' + result.archivePath, 'Backup exported (' + String(result.entries) + ' entries): ' + result.archivePath)
      error.textContent = ''
      exportButton.disabled = importButton.disabled = false
    } catch (caught) { fail(caught) }
  })()
})

importButton.addEventListener('click', () => {
  void (async () => {
    setBusy(t('正在导入备份…', 'Importing backup…'))
    try {
      const result = await bridge.importArchive()
      if (result.canceled) { setBusy(''); return }
      snapshot = await bridge.state()
      render()
      status.textContent = t('备份已导入（' + String(result.entries) + ' 个条目）' + (result.restarted ? '，Harness 已重新启动。' : '。'), 'Backup imported (' + String(result.entries) + ' entries)' + (result.restarted ? '; Harness restarted.' : '.'))
      error.textContent = ''
      exportButton.disabled = importButton.disabled = false
    } catch (caught) { fail(caught) }
  })()
})

void (async () => {
  try { snapshot = await bridge.state(); render() }
  catch (caught) { fail(caught) }
})()
