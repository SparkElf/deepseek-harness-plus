import { randomUUID } from 'node:crypto'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 在 Unix 原子发布完整 manifest；Windows 以原位写入避免打开文件时替换路径失败。
 * @param {string} manifestPath 目标 manifest 路径。
 * @param {string} content 完整 JSON 文本。
 * @returns {void}
 */
export function writeSupervisorManifest(manifestPath, content) {
  if (process.platform === 'win32') {
    writeFileSync(manifestPath, content, { mode: 0o600 })
    return
  }
  const temporaryPath = join(dirname(manifestPath), '.' + randomUUID() + '.tmp')
  try {
    writeFileSync(temporaryPath, content, { flag: 'wx', mode: 0o600 })
    renameSync(temporaryPath, manifestPath)
  } catch (error) {
    try { unlinkSync(temporaryPath) } catch (cleanupError) { if (cleanupError?.code !== 'ENOENT') console.error('[supervisor] manifest temp cleanup failed', cleanupError) }
    throw error
  }
}
