import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const runtimePath = resolve(repoRoot, '.cache/plus-web-system/runtime.json')

export default async function globalTeardown() {
  try {
    if (!existsSync(runtimePath)) return
    const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
    if (!Number.isSafeInteger(runtime.pid) || runtime.pid <= 0) throw new Error('Invalid Plus Web runtime pid')
    try {
      process.kill(-runtime.pid, 'SIGTERM')
    } catch (error) {
      if (error?.code === 'ESRCH') return
      throw error
    }
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      try {
        process.kill(runtime.pid, 0)
      } catch (error) {
        if (error?.code === 'ESRCH') return
        throw error
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
    process.kill(-runtime.pid, 'SIGKILL')
  } finally {
    rmSync(resolve(repoRoot, '.cache/plus-web-system/home/settings.yaml'), { force: true })
    rmSync(resolve(repoRoot, '.cache/plus-web-system/home/.credentials.yaml'), { force: true })
  }
}
