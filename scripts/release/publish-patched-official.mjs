#!/usr/bin/env node
/**
 * Publish the repackaged official workspaces the Plus patches modify.
 *
 * \`package-patched-official.mjs\` writes the package trees; this publishes them in
 * dependency order so a package's own dependencies already exist when it lands. The
 * registry rejects a publish whose dependency is absent, so publishing the leaf-most
 * packages first is what makes one run succeed.
 *
 * Usage:
 *   node scripts/release/publish-patched-official.mjs --dir <packaged-dir> [--dry-run]
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { attemptEchoed } from './process.ts'

/** Read one JSON file. */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Order packages so every dependency precedes its dependents.
 *
 * @param manifests - every package's manifest.
 * @returns the manifests in publish order.
 */
function publishOrder(manifests) {
  const byName = new Map(manifests.map(manifest => [manifest.name, manifest]))
  const order = []
  const placed = new Set()
  const visit = (manifest, seen) => {
    if (placed.has(manifest.name)) return
    if (seen.has(manifest.name)) throw new Error('dependency cycle at ' + manifest.name)
    seen.add(manifest.name)
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const dependency = byName.get(name)
      if (dependency !== undefined) visit(dependency, seen)
    }
    seen.delete(manifest.name)
    placed.add(manifest.name)
    order.push(manifest)
  }
  for (const manifest of manifests) visit(manifest, new Set())
  return order
}

const argv = process.argv.slice(2)
let dir
let dryRun = false
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--dir') { dir = argv[index + 1]; index += 1; continue }
  if (argv[index] === '--dry-run') { dryRun = true; continue }
  throw new Error('unknown option: ' + argv[index])
}
if (dir === undefined) throw new Error('usage: publish-patched-official.mjs --dir <packaged-dir> [--dry-run]')

const manifests = readdirSync(dir)
  .map(entry => join(dir, entry))
  .filter(path => { try { readJson(join(path, 'package.json')); return true } catch { return false } })
  .map(path => ({ path, manifest: readJson(join(path, 'package.json')) }))
const order = publishOrder(manifests.map(entry => entry.manifest))
const byName = new Map(manifests.map(entry => [entry.manifest.name, entry.path]))
console.log('publish-patched-official: ' + String(order.length) + ' package(s)' + (dryRun ? ' (dry run)' : ''))

for (const manifest of order) {
  const path = byName.get(manifest.name)
  // A prerelease version publishes to \`next\` unless told otherwise; npm refuses a
  // prerelease without an explicit tag rather than guessing which one it belongs to.
  const tag = manifest.version.includes('-') ? 'next' : 'latest'
  const args = ['publish', '--access', 'public', '--tag', tag]
  if (dryRun) args.push('--dry-run')
  const result = attemptEchoed('npm', args, { cwd: path })
  if (result.status !== 0) throw new Error('publish failed for ' + manifest.name)
  console.log('  published ' + manifest.name + '@' + manifest.version)
}
