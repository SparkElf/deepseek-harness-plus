#!/usr/bin/env node
/**
 * Memory-guardian CLI: run one guardian pass for a published `.graphs` graph.
 *
 *   node scripts/memory-guardian.mjs \
 *     --root <scope-root> --graph <graphId> --users <users-root> \
 *     --user <uid>[,<uid>...] [--department <code>] [--apply] [--json]
 *
 * The default is a dry run: it loads the graph, reports its version and what
 * the guardian would discover for each user, and writes nothing. `--apply`
 * resolves pending bindings (subscribe proxies, internalized copies), refreshes
 * subscribed versions and revokes branches whose source became a redline.
 *
 * Bindings live under `<users-root>/<uid>/bindings/` and never in Git; the
 * guardian is their single writer. Node 24 imports the TypeScript modules
 * directly; older Node re-executes with `--experimental-strip-types`.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { stat } from 'node:fs/promises'

const scriptPath = fileURLToPath(import.meta.url)

async function loadModules() {
  try {
    return {
      model: await import(new URL('../src/graphModel.ts', import.meta.url)),
      guardian: await import(new URL('../src/memoryGuardian.ts', import.meta.url)),
      bindings: await import(new URL('../src/memoryBindings.ts', import.meta.url)),
    }
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined
    const message = error instanceof Error ? error.message : String(error)
    const stripUnsupported = code === 'ERR_UNKNOWN_FILE_EXTENSION'
      || code === 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING'
      || message.includes('Unknown file extension')
    if (!stripUnsupported || process.env.KB_GUARDIAN_REEXEC === '1') throw error
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', scriptPath, ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, KB_GUARDIAN_REEXEC: '1' } },
    )
    process.exit(result.status ?? 1)
  }
}

function usage() {
  return [
    '用法: node scripts/memory-guardian.mjs --root <scope-root> --graph <graphId> --users <users-root> --user <uid[,uid...]> [--department <code>] [--apply] [--json]',
    '',
    '  --root <dir>        .graphs/<graphId>/ 所在的 scope 根目录（必填）',
    '  --graph <id>        图谱 id（必填）',
    '  --users <dir>       个人记忆根目录，其下是 <uid>/bindings/（必填）',
    '  --user <ids>        逗号分隔的 userId 列表（必填）',
    '  --department <code> 部门 code；department: 图谱只对该部门生效',
    '  --apply             真正处理 pending / 刷新订阅 / 撤销红线内化',
    '  --json              以 JSON 输出',
  ].join('\n')
}

function parseArgs(argv) {
  const parsed = { root: undefined, graph: undefined, users: undefined, users_: [], department: undefined, apply: false, json: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺少参数`)
      index += 1
      return value
    }
    if (arg === '--root') parsed.root = next()
    else if (arg === '--graph') parsed.graph = next()
    else if (arg === '--users') parsed.users = next()
    else if (arg === '--user' || arg === '--users-list') parsed.users_ = next().split(',').map(value => value.trim()).filter(Boolean)
    else if (arg === '--department') parsed.department = next()
    else if (arg === '--apply') parsed.apply = true
    else if (arg === '--json') parsed.json = true
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else throw new Error(`未知参数: ${arg}`)
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
  if (args.root === undefined || args.graph === undefined || args.users === undefined || args.users_.length === 0) {
    console.error(usage())
    process.exit(2)
  }
  try {
    const info = await stat(args.root)
    if (!info.isDirectory()) throw new Error('--root 不是目录')
  } catch (error) {
    console.error(`--root 不可用: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }

  const { model, guardian, bindings } = await loadModules()
  const loaded = await model.loadGraph(args.root, args.graph)
  const graph = { ...loaded, commit: process.env.KB_GUARDIAN_COMMIT }
  const store = new bindings.BindingStore(args.users)

  const existing = []
  for (const userId of args.users_) {
    for (const binding of await store.list(userId)) {
      existing.push({
        userId,
        sourceType: binding.sourceType,
        sourceId: binding.sourceId,
        mode: binding.mode,
        status: binding.status,
        sourceVersion: binding.sourceVersion,
      })
    }
  }

  if (!args.apply) {
    const report = {
      dryRun: true,
      graph: {
        id: loaded.manifest.id,
        name: loaded.manifest.name,
        version: loaded.manifest.version,
        status: loaded.manifest.status,
        scope: loaded.manifest.scope,
        nodes: loaded.nodes.length,
        edges: loaded.edges.length,
        issues: loaded.issues.filter(issue => issue.severity === 'error').length,
      },
      users: args.users_,
      existingBindings: existing.length,
      wouldDiscover: loaded.manifest.status === 'draft' || loaded.manifest.status === 'archived'
        ? 0
        : loaded.nodes.length + loaded.edges.length,
      note: '未写入。确认后加 --apply 执行守护会话处理。',
      bindings: existing,
    }
    if (args.json) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(`图谱 ${report.graph.name ?? report.graph.id} v${report.graph.version} (${report.graph.status})`)
      console.log(`节点 ${report.graph.nodes} / 关系 ${report.graph.edges} / error ${report.graph.issues}`)
      console.log(`用户 ${args.users_.join(', ')}；现有绑定 ${existing.length}；发现候选 ${report.wouldDiscover}`)
      console.log(report.note)
    }
    return
  }

  const result = await guardian.runGuardianPass({
    graph,
    usersRoot: args.users,
    userIds: args.users_,
    ...(args.department === undefined ? {} : { departmentCode: args.department }),
  })
  const output = { dryRun: false, graphId: loaded.manifest.id, version: loaded.manifest.version, result }
  if (args.json) console.log(JSON.stringify(output, null, 2))
  else {
    console.log(`守护会话已处理 ${loaded.manifest.id} v${loaded.manifest.version}`)
    console.log(`pending=${result.createdPending} subscribe=${result.subscribed} internalize=${result.internalized} redline拒绝=${result.rejectedRedline} 版本刷新=${result.upstreamUpdates} 撤销=${result.revoked}`)
  }
}

main().catch(error => {
  console.error(`memory-guardian 失败: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})