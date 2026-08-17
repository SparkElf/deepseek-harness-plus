/** Settings Backup section dictionaries (zh product copy, en twin). */

export const zh = {
  nav: '备份',
  title: '备份与恢复',
  desc: '把用户设置和数据导出为一个 zip 压缩包，或从备份压缩包恢复。',
  exportButton: '导出备份压缩包',
  importButton: '选择压缩包并导入',
  busyExport: '正在导出备份…',
  busyImport: '正在导入备份…',
  exported: '备份已导出，浏览器已开始下载。',
  imported: '备份已导入，用户设置和数据已恢复。',
  notBackup: '所选压缩包不是 DeepSeek Harness 备份文件。',
  unsafe: '备份压缩包包含不安全的条目路径。',
  failed: '操作失败，请稍后重试。',
  warning: '备份压缩包包含 API 密钥等敏感信息，请妥善保管。',
} as const

/** English twin of the `zh` dictionary. */
export const en: Record<SettingsBackupKey, string> = {
  nav: 'Backup',
  title: 'Backup and restore',
  desc: 'Export user settings and data as one zip archive, or restore them from a backup archive.',
  exportButton: 'Export backup archive',
  importButton: 'Choose archive and import',
  busyExport: 'Exporting backup…',
  busyImport: 'Importing backup…',
  exported: 'Backup exported; the browser download has started.',
  imported: 'Backup imported; user settings and data restored.',
  notBackup: 'The selected archive is not a DeepSeek Harness backup file.',
  unsafe: 'The backup archive contains unsafe entry paths.',
  failed: 'The operation failed; try again later.',
  warning: 'The backup archive contains sensitive data such as API keys; store it carefully.',
}

/** Dictionary keys of the `settingsBackup` locale namespace. */
export type SettingsBackupKey = keyof typeof zh
