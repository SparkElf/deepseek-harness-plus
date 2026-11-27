#!/usr/bin/env node
/**
 * Legacy knowledge-graph migration CLI.
 *
 *   node scripts/migrate-graphs.mjs --root <scope-root> [--apply] [--json] [--force]
 *
 * The default is a dry run: the planner only reads. `--apply` performs the
 * planned writes/moves/deletes after the plan validates; `--force` only allows
 * an existing `.graphs/<graph>/graph.json` to be overwritten. Exit code 1 means
 * at least one error-level issue (or a failed apply); warnings such as title
 * conflicts do not fail the run, but they do leave the legacy file untouched.
 *
 * Node 24 can import the TypeScript planner directly. Node 22.19 needs
 * `--experimental-strip-types`; this wrapper re-executes itself with that flag
 * so the documented plain `node scripts/migrate-graphs.mjs` command still works.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { stat } from 'node:fs/promises'

const scriptPath = fileURLToPath(import.meta.url)

async function loadPlanner() {
  try {
    return await import(new URL('../src/graphMigration.ts', import.meta.url))
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined
    const message = error instanceof Error ? error.message : String(error)
    const stripUnsupported = code === 'ERR_UNKNOWN_FILE_EXTENSION'
      || code === 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING'
      || message.includes('Unknown file extension')
    if (!stripUnsupported || process.env.KB_MIGRATE_REEXEC === '1') throw error
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', scriptPath, ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, KB_MIGRATE_REEXEC: '1' } },
    )
    process.exit(result.status ?? 1)
  }
}

function usage() {
  return [
    '用法: node scripts/migrate-graphs.mjs --root <scope-root> [--apply] [--json] [--force]',
    '',
    '  --root <dir>  知识图谱/ 所在的 scope 根目录（必填）',
    '  --apply       执行迁移（默认 dry-run，只读）',
    '  --json        以 JSON 输出报告',
    '  --force       允许覆盖已存在的 .graphs/<graph>/graph.json',
  ].join('\n')
}

function parseArgs(argv) {
  const parsed = { root: undefined, apply: false, json: false, force: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('--root 需要一个目录参数')
      parsed.root = value
      index += 1
      continue
    }
    if (arg === '--apply') {
      parsed.apply = true
      continue
    }
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg === '--force') {
      parsed.force = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      parsed.help = true
      continue
    }
    throw new Error(`未知参数: ${arg}`)
  }
  return parsed
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(usage())
    process.exit(2)
  }
  if (args.help) {
    console.log(usage())
    return
  }
  if (args.root === undefined) {
    console.error('缺少 --root 参数')
    console.error(usage())
    process.exit(2)
  }

  const planner = await loadPlanner()
  const scopeRoot = resolve(args.root)
  try {
    if (!(await stat(scopeRoot)).isDirectory()) throw new Error('not a directory')
  } catch {
    console.error(`--root 不是可读目录: ${scopeRoot}`)
    process.exit(2)
  }
  const options = {
    scopeRoot,
    dryRun: !args.apply,
    ...(args.force ? { force: true } : {}),
  }
  let report = await planner.planMigration(options)
  if (args.apply && !planner.migrationReportHasErrors(report)) {
    report = await planner.applyMigration({ ...options, dryRun: false, report })
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(planner.renderMigrationReport(report))
  }
  if (planner.migrationReportHasErrors(report) || (args.apply && report.applied === false)) {
    process.exitCode = 1
  }
}

await main().catch(error => {
  console.error(`迁移失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})