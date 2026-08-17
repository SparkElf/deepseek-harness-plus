import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 校验打包产物中 unpacked Supervisor 模块在没有 workspace node_modules 的环境里完成解析。
 * 从 dist 内定位 app.asar.unpacked，把它复制到临时隔离目录再动态导入 Supervisor 模块图，
 * 阻断向仓库 node_modules 的回退解析，还原安装目录的解析环境。
 * @returns {Promise<void>} 结构缺失或任一外部依赖解析失败时以非零退出结束进程。
 */
async function main() {
  const distDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
  const unpacked = await findUnpacked(distDirectory)
  if (unpacked === undefined) {
    console.error('[verify-unpacked-imports] no app.asar.unpacked found under ' + distDirectory)
    process.exitCode = 1
    return
  }
  const yamlManifest = join(unpacked, 'node_modules', 'yaml', 'package.json')
  if (!await exists(yamlManifest)) {
    console.error('[verify-unpacked-imports] packaged tree is missing node_modules/yaml beside the unpacked sources')
    process.exitCode = 1
    return
  }
  const isolated = await mkdtemp(join(tmpdir(), 'dsh-unpacked-verify-'))
  const target = join(isolated, 'app.asar.unpacked')
  try {
    await cp(unpacked, target, { recursive: true })
    const modules = ['supervisor.mjs', 'supervisor-locale.mjs', 'supervisor-manifest.mjs', 'supervisor-progress-server.mjs']
    for (const name of modules) {
      try {
        await import(pathToFileURL(join(target, 'src', name)).href)
        console.log('[verify-unpacked-imports] resolved ' + name)
      } catch (error) {
        console.error('[verify-unpacked-imports] failed to resolve ' + name, error)
        process.exitCode = 1
        return
      }
    }
  } finally {
    await rm(isolated, { recursive: true, force: true })
  }
}

async function exists(path) {
  try { await stat(path); return true } catch { return false }
}

/** 在打包输出目录内递归查找 app.asar.unpacked 目录。 */
async function findUnpacked(directory) {
  let entries
  try { entries = await readdir(directory) } catch { return undefined }
  for (const entry of entries) {
    const path = join(directory, entry)
    if (entry === 'app.asar.unpacked' && (await stat(path)).isDirectory()) return path
  }
  for (const entry of entries) {
    const path = join(directory, entry)
    if ((await stat(path)).isDirectory()) {
      const found = await findUnpacked(path)
      if (found !== undefined) return found
    }
  }
  return undefined
}

await main()
