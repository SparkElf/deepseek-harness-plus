import AdmZip from 'adm-zip'

/** 备份压缩包根部的清单文件，导入校验以此为标记。 */
export const BACKUP_MANIFEST_ENTRY = 'backup-manifest.json'

/**
 * 将 dshHome 目录完整导出为一个 zip 备份包。
 * @param {string} dshHome Harness 用户数据目录。
 * @param {string} targetPath 备份包写入路径。
 * @returns {{ archivePath: string, entries: number }} 写入结果。
 */
export function exportUserBackup(dshHome, targetPath) {
  const zip = new AdmZip()
  zip.addLocalFolder(dshHome)
  const manifest = {
    app: 'deepseek-harness-plus',
    kind: 'user-data-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
  }
  zip.addFile(BACKUP_MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest, null, 2) + String.fromCharCode(10)))
  zip.writeZip(targetPath)
  return { archivePath: targetPath, entries: zip.getEntries().length }
}

/**
 * 校验备份包：必须携带清单标记，且所有条目路径安全。校验不修改任何文件，
 * 因此可以在停止 runtime 之前执行，无效压缩包不会把 Harness 停在停止状态。
 * @param {string} archivePath 备份包路径。
 * @returns {{ zip: AdmZip, entries: number }} 已打开并通过校验的压缩包。
 */
export function validateUserBackup(archivePath) {
  const zip = new AdmZip(archivePath)
  const entries = zip.getEntries()
  if (!entries.some(entry => entry.entryName === BACKUP_MANIFEST_ENTRY)) {
    throw new Error('Not a DeepSeek Harness Plus user data backup: missing ' + BACKUP_MANIFEST_ENTRY)
  }
  for (const entry of entries) {
    const name = entry.entryName
    if (name.startsWith('/') || name.includes('\\')) throw new Error('Backup archive contains an unsafe path: ' + name)
    const parts = name.split('/')
    for (const [index, part] of parts.entries()) {
      if (part === '..') throw new Error('Backup archive contains an unsafe path: ' + name)
      if (part === '' && index < parts.length - 1) throw new Error('Backup archive contains an unsafe path: ' + name)
    }
  }
  return { zip, entries: entries.length }
}

/**
 * 把通过校验的备份包恢复到 dshHome；同名文件被覆盖，其余文件保留。
 * @param {{ zip: AdmZip, entries: number }} validated validateUserBackup 的返回值。
 * @param {string} dshHome Harness 用户数据目录。
 * @returns {{ entries: number }} 恢复的条目数量。
 */
export function restoreUserBackup(validated, dshHome) {
  validated.zip.extractAllTo(dshHome, true)
  return { entries: validated.entries }
}

/**
 * 校验并恢复备份包的一步式入口。
 * @param {string} archivePath 备份包路径。
 * @param {string} dshHome Harness 用户数据目录。
 * @returns {{ entries: number }} 恢复的条目数量。
 */
export function importUserBackup(archivePath, dshHome) {
  return restoreUserBackup(validateUserBackup(archivePath), dshHome)
}
