/** Run serial browser owners before one bounded snapshot pool. */
import { spawn } from 'node:child_process'

const serialOwners = [
  'apps/web/tests/hmr-live.e2e.ts',
  'apps/web/tests/cordis-tool-round.e2e.ts',
]

if (import.meta.main) process.exitCode = await main()

async function main(): Promise<number> {
  const workerRaw = process.env.DSH_WEB_SNAPSHOT_WORKERS
  const workers = Number.parseInt(workerRaw ?? '', 10)
  if (!Number.isSafeInteger(workers) || workers < 2 || String(workers) !== workerRaw) {
    throw new Error('DSH_WEB_SNAPSHOT_WORKERS must be an integer greater than 1, got ' + JSON.stringify(workerRaw) + '.')
  }
  const pnpmEntrypoint = process.env.npm_execpath
  if (pnpmEntrypoint === undefined || pnpmEntrypoint === '') {
    throw new Error('parallel web snapshots must be invoked through a pnpm package script.')
  }

  const selection = partitionWebSnapshotFiles(parseWebSnapshotSelection(process.env.DSH_WEB_SNAPSHOT_FILES))
  const baseArgs = [pnpmEntrypoint, 'exec', 'vitest', 'run', '--config', 'vitest.web.config.ts']

  for (const file of selection.serial) {
    const status = await run([...baseArgs, file])
    if (status !== 0) return status
  }
  if (selection.parallel !== undefined && selection.parallel.length === 0) return 0

  return run([
    ...baseArgs,
    ...(selection.parallel ?? serialOwners.map(file => '--exclude=' + file)),
    '--fileParallelism',
    '--maxWorkers=' + String(workers),
  ])
}

/**
 * Parse the optional affected-file selection owned by the CI impact planner.
 * @param raw - JSON-encoded Web test paths, or undefined for the complete suite.
 * @returns The selected files, or undefined for the complete suite.
 */
export function parseWebSnapshotSelection(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(file => typeof file !== 'string')) {
    throw new Error('DSH_WEB_SNAPSHOT_FILES must be a non-empty JSON array of Web test files.')
  }
  const files = parsed as string[]
  if (new Set(files).size !== files.length) throw new Error('DSH_WEB_SNAPSHOT_FILES must not contain duplicates.')
  for (const file of files) {
    if (!/^apps\/web\/tests\/[^/]+\.(?:e2e|snapshot)\.ts$/u.test(file)) {
      throw new Error('affected Web test must be an e2e or snapshot file under apps/web/tests: ' + JSON.stringify(file) + '.')
    }
  }
  return files
}

/**
 * Keep serial owners outside the bounded parallel pool for full and affected runs.
 * @param selected - Affected files, or undefined for the complete suite.
 * @returns Serial files and optional explicit parallel files.
 */
export function partitionWebSnapshotFiles(selected: string[] | undefined): {
  serial: string[]
  parallel: string[] | undefined
} {
  if (selected === undefined) return { serial: serialOwners, parallel: undefined }
  return {
    serial: serialOwners.filter(file => selected.includes(file)),
    parallel: selected.filter(file => !serialOwners.includes(file)),
  }
}

function run(args: string[]): Promise<number> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (exitCode, signalCode) => {
      if (signalCode !== null) {
        console.error('web snapshots terminated by ' + signalCode)
        resolveRun(1)
        return
      }
      resolveRun(exitCode ?? 1)
    })
  })
}
