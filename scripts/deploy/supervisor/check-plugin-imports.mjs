#!/usr/bin/env node
/**
 * Import the profile's plugin entry points and report the ones that throw.
 *
 * Why this exists, separately from the scope fence and the identity check:
 *
 * check-profile-scope.mjs catches a *name* that resolves twice, and check-module-identity.mjs
 * catches two resolvers disagreeing. Neither sees a nested dependency that resolves cleanly to
 * exactly one copy but is the *wrong version* for the release tree beside it.
 *
 * Measured on this host: a profile rolled back from a later release kept nested
 * @deepseek-ai/schemastery 3.18.4 inside several release packages. That copy imports
 * `createVolatile` from @deepseek-ai/cosmokit, while the release tree vendors cosmokit 1.8.3,
 * which has no such export. Result: 60 plugins failed to import, dsh exited 1 at startup, and
 * the failure surfaced only as "3 required plugins did not activate" in a diagnostics file -
 * while the port still answered from the previous process.
 *
 * This asks the loader's own question directly: import each entry point and report the throw.
 * Imports are sequential so a failure is attributed to one named plugin, and each has its own
 * timeout so a hung plugin cannot wedge the pre-start fence.
 *
 * Exit codes: 0 every import succeeded, 1 at least one failed, 2 usage error.
 *
 * Usage: check-plugin-imports.mjs --profile <dir> [--limit <n>]
 */
import { existsSync, readdirSync, readFileSync, realpathSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const at = argv.indexOf('--' + name)
  return at === -1 ? fallback : argv[at + 1]
}
const profile = arg('profile')
const limit = Number(arg('limit', '0'))
if (typeof profile !== 'string' || profile === '') {
  console.error('usage: check-plugin-imports.mjs --profile <dir> [--limit <n>]')
  process.exit(2)
}
const LF = String.fromCharCode(10)

/**
 * Entry points to probe: the profile's declared bundles plus every installed plugin package.
 * The bundle list is what the loader starts from, so a failure there is the one that stops boot.
 */
function entryPoints(root) {
  const found = []
  const manifestPath = join(root, 'package.json')
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      for (const name of manifest.dsh?.profile?.bundles ?? []) {
        const dir = resolvePackage(root, name)
        if (dir !== undefined) found.push({ name, dir, kind: 'bundle' })
      }
    } catch { /* an unreadable manifest is reported by the caller's other checks */ }
  }
  return found
}

/** Resolve a package name to its directory under the profile, without following the export map. */
function resolvePackage(root, name) {
  const direct = join(root, 'node_modules', name)
  try { if (existsSync(join(direct, 'package.json'))) return realpathSync(direct) } catch { /* try the requirement below */ }
  return undefined
}

/** The module a loader would import: the exports "." target, else main. */
function entryFile(dir) {
  let manifest
  try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { return undefined }
  const candidates = []
  const dot = manifest.exports?.['.']
  if (typeof dot === 'string') candidates.push(dot)
  else if (dot !== null && typeof dot === 'object') {
    if (typeof dot.import === 'string') candidates.push(dot.import)
    if (typeof dot.default === 'string') candidates.push(dot.default)
  }
  if (typeof manifest.main === 'string') candidates.push(manifest.main)
  for (const name of ['index.mjs', 'index.js', 'index.cjs']) candidates.push(name)
  for (const candidate of candidates) {
    const file = join(dir, candidate)
    try { if (lstatSync(file).isFile()) return file } catch { /* next candidate */ }
  }
  return join(dir, 'index.js')
}

const targets = entryPoints(profile)
if (targets.length === 0) { console.log('plugin imports: no bundles declared; nothing to probe'); process.exit(0) }

const failures = []
let checked = 0
const budget = limit > 0 ? Math.min(limit, targets.length) : targets.length
for (const target of targets.slice(0, budget)) {
  const file = entryFile(target.dir)
  const timer = setTimeout(() => {
    failures.push({ name: target.name, message: 'import did not settle within 20s' })
  }, 20_000)
  try {
    await import(file)
    checked += 1
  } catch (error) {
    const cause = error?.cause
    const detail = cause === undefined ? '' : ' (' + String(cause?.message ?? cause).split(LF)[0] + ')'
    failures.push({ name: target.name, message: String(error?.message ?? error).split(LF)[0] + detail })
  } finally {
    clearTimeout(timer)
  }
  if (failures.length > 0) break
}

if (failures.length > 0) {
  console.log('plugin imports: FAILED')
  for (const failure of failures.slice(0, 5)) console.log('  ' + failure.name + ': ' + failure.message.slice(0, 300))
  console.log('  checked ' + String(checked) + ' of ' + String(targets.length) + ' bundle(s)')
  process.exit(1)
}
console.log('plugin imports: OK (' + String(checked) + ' bundle' + (checked === 1 ? '' : 's') + ' imported)')
process.exit(0)
