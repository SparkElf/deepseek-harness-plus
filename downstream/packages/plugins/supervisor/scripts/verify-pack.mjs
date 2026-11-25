import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
assert.equal(manifest.bin?.['dsh-plus-supervisor'], 'lib/bin.js')
assert.match(readFileSync(resolve(root, 'lib/bin.js'), 'utf8'), /^#!\/usr\/bin\/env node/)
const result = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }))
// npm answers this command in two shapes: an array of pack results, or an object keyed by
// package name (npm 12). This read indexed the parsed value with [0] before either shape
// was considered, so under npm 12 it took the object's "0" property, got undefined, and
// threw "Cannot convert undefined or null to object" - the gate failed outright rather
// than verifying anything.
const packed = Array.isArray(result) ? result[0] : Object.values(result)[0]
if (packed === undefined || !Array.isArray(packed.files)) {
  throw new Error('npm pack --json returned no file list; keys: ' + Object.keys(result).join(', '))
}
const files = new Set(packed.files.map(entry => entry.path))
for (const path of [
  'LICENSE', 'README.md', 'cordis.patch.yml', 'package.json',
  'lib/index.js', 'lib/invariant.js', 'lib/bin.js',
  'lib/types/index.d.ts', 'lib/types/invariant.d.ts', 'lib/types/bin.d.ts',
  'runtime/bin.mjs', 'runtime/client.mjs', 'runtime/manifest.mjs', 'runtime/supervisor.mjs',
  'progress/index.html', 'progress/app.js', 'progress/styles.css',
]) assert.equal(files.has(path), true, 'missing packed file: ' + path)
for (const entry of files) {
  assert.equal(entry.startsWith('src/'), false, 'source leaked into tarball: ' + entry)
  assert.equal(entry.startsWith('test/'), false, 'test leaked into tarball: ' + entry)
  assert.equal(entry.startsWith('scripts/'), false, 'script leaked into tarball: ' + entry)
}
console.log('supervisor pack OK (' + files.size + ' files)')
