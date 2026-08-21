import AdmZip from 'adm-zip'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 备份压缩包根部的清单文件，导入校验以此为标记。 */
export const BACKUP_MANIFEST_ENTRY = 'backup-manifest.json'

/**
 * dshHome 中运行时生成的目录，不属于用户配置和数据：
 * profiles 是运行时重建的插件工作区（含符号链接 node_modules），supervisor 是运行日志。
 */
const GENERATED_DIRECTORIES = new Set(['profiles', 'supervisor'])

/**
 * 把目录递归加入 zip；条目名使用正斜杠。符号链接等非常规条目跳过：
 * 运行时链接不可移植，用户配置和数据都是普通文件。
 * @param {AdmZip} zip 目标压缩包。
 * @param {string} rootPath 遍历根目录。
 * @param {string} relativePath 相对遍历根的当前路径，根为空字符串。
 * @returns {void}
 */
function addDirectoryToZip(zip, rootPath, relativePath) {
  const entries = readdirSync(join(rootPath, relativePath), { withFileTypes: true })
  for (const entry of entries) {
    const entryRelative = relativePath === '' ? entry.name : relativePath + '/' + entry.name
    if (entry.isDirectory()) {
      if (relativePath === '' && GENERATED_DIRECTORIES.has(entry.name)) continue
      zip.addFile(entryRelative + '/', Buffer.alloc(0))
      addDirectoryToZip(zip, rootPath, entryRelative)
    } else if (entry.isFile()) {
      zip.addFile(entryRelative, readFileSync(join(rootPath, relativePath, entry.name)))
    }
  }
}

/**
 * 将 dshHome 的用户配置和数据导出为一个 zip 备份包。
 * 包含 settings（含 provider 和模型配置）、凭据明文、storages 等用户数据；
 * 跳过运行时生成的 profiles 和 supervisor 目录。
 * @param {string} dshHome Harness 用户数据目录。
 * @param {string} targetPath 备份包写入路径。
 * @returns {{ archivePath: string, entries: number }} 写入结果。
 */
export function exportUserBackup(dshHome, targetPath) {
  const zip = new AdmZip()
  addDirectoryToZip(zip, dshHome, '')
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
