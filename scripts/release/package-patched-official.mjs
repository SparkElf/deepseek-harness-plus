#!/usr/bin/env node
/**
 * Package the patched official DSH workspaces for publication under our scope.
 *
 * Plus patches official DSH source, which a registry installation cannot apply: the
 * published packages carry built \`lib/\` output and no \`src/\`, so a source patch has
 * nowhere to land. The alternative is to publish the patched packages themselves —
 * the approach the Desktop installer already takes at build time, moved to release
 * time so a consumer needs no checkout, no toolchain, and no build.
 *
 * This reads a built official checkout that already has the patches applied (the
 * release mirror), copies each affected workspace into a package tree, rewrites the
 * name onto our scope and the workspace dependency specifiers onto real versions, and
 * writes them under \`--out\` ready for \`npm publish\`.
 *
 * Usage:
 *   node scripts/release/package-patched-official.mjs --source <built-checkout> --out <dir>
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Our scope replaces the official one on every republished package. */
const OUR_SCOPE = '@sparkelf/'

/** The official scope this script rewrites. */
const OFFICIAL_SCOPE = '@deepseek-ai/'

/**
 * The workspaces the Plus patches modify, by repository path.
 *
 * The list is explicit: a patch that adds a workspace must add it here too, which is
 * what makes the omission visible at review time instead of as a missing package.
 */
const PATCHED_WORKSPACES = [
  'apps/web',
  'packages/api/gateway',
  'packages/api/session-controller',
  'packages/bundle/web-app',
  'packages/client/connection',
  'packages/client/ui-agent-preset',
  'packages/client/ui-conversation',
  'packages/client/ui-deliverables',
  'packages/client/ui-layout',
  'packages/client/ui-model-selection',
  'packages/client/ui-primitives',
  'packages/client/ui-settings-models',
  'packages/client/ui-trajectory',
  'packages/core/tools',
  'packages/host/frontend-static',
  'packages/host/webserver',
  'packages/llm/llm-pi-ai',
  'packages/preset/agent-presets',
  'packages/session-query/session-log-export',
  'packages/workspace/workspace',
]

/** Files and directories a published package must carry. */
const PUBLISHED_FILES = ['lib', 'presets', 'skills', 'README.md', 'README.zh.md', 'LICENSE']

/** Read one JSON file. */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Rename one package onto our scope.
 * @param name - the official package name.
 * @returns the republished name.
 */
function ourName(name) {
  if (!name.startsWith(OFFICIAL_SCOPE)) throw new Error('not an official package name: ' + name)
  return OUR_SCOPE + name.slice(OFFICIAL_SCOPE.length)
}

/**
 * Rewrite every workspace specifier in a dependency map onto a real version.
 *
 * Every dependency keeps its official name, including a package this script
 * republishes. The built code imports the official specifier — \`@deepseek-ai/dsh-tools\`
 * appears verbatim in \`lib/index.js\` — and Node resolves an import by name, so the
 * installed location must carry that name. Renaming a dependency here would point the
 * manifest at a package name the code never asks for, and the import would fail.
 *
 * The consumer's \`overrides\` map is what substitutes our build for the official one;
 * this function only turns the workspace protocol into a version.
 *
 * @param map - the dependency map, or undefined.
 * @param versions - official package name to published version.
 * @returns the rewritten map, or undefined when there was none.
 */
function rewriteSpecs(map, versions) {
  if (map === undefined) return undefined
  const out = {}
  for (const [name, spec] of Object.entries(map)) {
    if (typeof spec === 'string' && spec.startsWith('workspace:')) {
      const version = versions[name]
      if (version === undefined) throw new Error('no version for workspace dependency ' + name)
      out[name] = '^' + version
      continue
    }
    out[name] = spec
  }
  return out
}

/**
 * Collect the published version of every official package a workspace may depend on.
 *
 * Two trees hold them: \`packages/<group>/<name>\` for the product workspaces, and
 * \`vendor/<name>\` for the pinned upstream copies the official registry also serves.
 * Missing the vendor tree made every workspace specifier onto a vendored package look
 * unresolvable.
 *
 * @param source - built official checkout root.
 * @returns official name to version.
 */
function officialVersions(source) {
  const versions = {}
  const collect = (manifestPath) => {
    if (!existsSync(manifestPath)) return
    const manifest = readJson(manifestPath)
    if (typeof manifest.name === 'string') versions[manifest.name] = manifest.version
  }
  const root = join(source, 'packages')
  for (const group of readdirNames(root)) {
    for (const name of readdirNames(join(root, group))) collect(join(root, group, name, 'package.json'))
  }
  const vendor = join(source, 'vendor')
  for (const name of readdirNames(vendor)) collect(join(vendor, name, 'package.json'))
  // The web frontend is an application workspace, outside \`packages/\`.
  collect(join(source, 'apps', 'web', 'package.json'))
  return versions
}

/** Names of the direct children of a directory, empty when it does not exist. */
function readdirNames(path) {
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
}

/**
 * Write one republished package.
 * @param source - built official checkout root.
 * @param out - output directory.
 * @param workspace - repository-relative workspace path.
 * @param versions - official name to version.
 * @returns the republished package name.
 */
function packageWorkspace(source, out, workspace, versions) {
  const from = join(source, workspace)
  const manifest = readJson(join(from, 'package.json'))
  const target = join(out, ourName(manifest.name).replace(OFFICIAL_SCOPE, '').replace('/', '__'))
  mkdirSync(target, { recursive: true })
  for (const entry of PUBLISHED_FILES) {
    const candidate = join(from, entry)
    if (existsSync(candidate)) cpSync(candidate, join(target, entry), { recursive: true })
  }
  const published = {
    ...manifest,
    name: ourName(manifest.name),
    // The official repository is not ours to point at, and a consumer reading the
    // manifest should reach the code that produced it.
    repository: { type: 'git', url: 'git+https://github.com/SparkElf/deepseek-harness-plus.git' },
    publishConfig: { access: 'public' },
  }
  published.dependencies = rewriteSpecs(manifest.dependencies, versions)
  published.peerDependencies = rewriteSpecs(manifest.peerDependencies, versions)
  published.optionalDependencies = rewriteSpecs(manifest.optionalDependencies, versions)
  for (const key of ['devDependencies', 'scripts', 'dsh', 'private']) delete published[key]
  writeFileSync(join(target, 'package.json'), JSON.stringify(published, null, 2) + String.fromCharCode(10))
  return published.name
}

const argv = process.argv.slice(2)
let source
let out
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--source') { source = argv[index + 1]; index += 1; continue }
  if (argv[index] === '--out') { out = argv[index + 1]; index += 1; continue }
  throw new Error('unknown option: ' + argv[index])
}
if (source === undefined || out === undefined) {
  throw new Error('usage: package-patched-official.mjs --source <built-checkout> --out <dir>')
}
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const versions = officialVersions(resolve(source))
const names = PATCHED_WORKSPACES.map(workspace =>
  packageWorkspace(resolve(source), resolve(out), workspace, versions))
console.log('package-patched-official: ' + String(names.length) + ' package(s) written to ' + out)
for (const name of names) console.log('  ' + name)
