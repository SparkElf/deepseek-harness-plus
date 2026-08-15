import { randomUUID } from 'node:crypto'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 原子发布完整的 Supervisor manifest，避免 watcher 读取半写入 JSON。
 * @param {string} manifestPath 目标 manifest 路径。
 * @param {string} content 完整 JSON 文本。
 * @returns {void}
 */
export function writeSupervisorManifest(manifestPath, content) {
  const temporaryPath = join(dirname(manifestPath), '.' + randomUUID() + '.tmp')
  try {
    writeFileSync(temporaryPath, content, { flag: 'wx', mode: 0o600 })
    renameSync(temporaryPath, manifestPath)
  } catch (error) {
    try { unlinkSync(temporaryPath) } catch (cleanupError) { if (cleanupError?.code !== 'ENOENT') console.error('[supervisor] manifest temp cleanup failed', cleanupError) }
    throw error
  }
}
