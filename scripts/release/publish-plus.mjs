#!/usr/bin/env node
/**
 * Publish the Plus bundle with workspace: dependency ranges expanded.
 *
 * npm publishes `workspace:` ranges verbatim, and `npm install -g <tarball>`
 * then fails outside the monorepo with EUNSUPPORTEDPROTOCOL. The tarball must
 * carry concrete ranges, so this wrapper rewrites the manifest right before
 * `npm publish` and restores it afterwards.
 *
 * Usage: node scripts/release/publish-plus.mjs [--tag alpha]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const manifestPath = new URL('../../packages/bundle/plus/package.json', import.meta.url)
const original = readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(original)

/** Expand one dependency map in place. */
function rewrite(map) {
  if (map === undefined) return
  for (const [name, range] of Object.entries(map)) {
    if (typeof range !== 'string' || !range.startsWith('workspace:')) continue
    let next = range.slice('workspace:'.length)
    if (next === '^' || next === '~' || next === '*') {
      try {
        const installed = JSON.parse(
          readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), 'utf8'),
        )
        next = next === '*' ? installed.version : `${next}${installed.version}`
      } catch {
        next = '*'
      }
    }
    map[name] = next
  }
}

rewrite(manifest.dependencies)
rewrite(manifest.optionalDependencies)
rewrite(manifest.devDependencies)
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

const tag = process.argv.includes('--tag') ? process.argv[process.argv.indexOf('--tag') + 1] : 'alpha'
try {
  execFileSync('npm', ['publish', '--registry=https://registry.npmjs.org/', '--tag', tag], {
    cwd: new URL('../../packages/bundle/plus', import.meta.url).pathname,
    stdio: 'inherit',
  })
} finally {
  writeFileSync(manifestPath, original)
}
