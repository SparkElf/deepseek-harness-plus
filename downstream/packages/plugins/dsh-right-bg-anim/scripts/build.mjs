/**
 * Bundle the browser half into lib/client.js.
 *
 * The DSH client module system loads a plugin's browser half as ONE classic
 * script that registers itself on window.__ModuleLoader__ - it does not resolve
 * relative imports from that file. The sources are therefore concatenated into a
 * single factory: every relative import is stripped (order below is the load
 * order) and every "export const/function/class" becomes a plain declaration.
 * No bundler, no dependencies, nothing installed.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const MODULES = [
  'src/anim/fluid-profile.js',
  'src/anim/elastic-grid-profile.js',
  'src/anim/fluid-shaders.js',
  'src/anim/interaction-sources.js',
  'src/anim/pointer-field.js',
  'src/anim/elastic-grid.js',
  'src/css.js',
  'src/settings.js',
  'src/wallpaper-profile.js',
  'src/client.js',
]

const IMPORT_LINE = /^import\s+[\s\S]*?from\s+["'][^"']+["']\s*;?$/gm
const SIDE_EFFECT_IMPORT = /^import\s+["'][^"']+["']\s*;?$/gm
const EXPORT_DECL = /^export\s+(const|let|function|class)\s/gm

function inline(source, path) {
  if (/^export\s+default\s/m.test(source)) throw new Error(path + ': default exports cannot be inlined')
  if (/^export\s*\{/m.test(source)) throw new Error(path + ': export lists cannot be inlined')
  return source
    .replace(IMPORT_LINE, '')
    .replace(SIDE_EFFECT_IMPORT, '')
    .replace(EXPORT_DECL, '$1 ')
}

const parts = []
for (const path of MODULES) parts.push(inline(await readFile(resolve(here, '..', path), 'utf8'), path).trim())

/* The sources are concatenated into ONE scope, so a duplicate top-level name
   would throw at parse time. Catch it here with the offending module named. */
const DECLARED = /^(?:const|let|class|function)\s+([A-Za-z_$][\w$]*)/gm
const owners = new Map()
for (let index = 0; index < MODULES.length; index += 1) {
  for (const match of parts[index].matchAll(DECLARED)) {
    const previous = owners.get(match[1])
    if (previous !== undefined) {
      throw new Error('duplicate top-level declaration "' + match[1] + '" in ' + MODULES[index] + ' (already in ' + previous + ')')
    }
    owners.set(match[1], MODULES[index])
  }
}

const bundle = [
  "window.__ModuleLoader__.load({ id: 'dsh-right-bg-anim', factory: (require) => {",
  'var module = { exports: {} };',
  'var exports = module.exports;',
  parts.join('\n\n'),
  '',
  'module.exports = { apply, inject };',
  'return module.exports; } });',
  '',
].join('\n')

const out = resolve(here, '..', 'lib', 'client.js')
await mkdir(dirname(out), { recursive: true })
await writeFile(out, bundle)
const host = resolve(here, '..', 'lib', 'index.js')
await copyFile(resolve(here, '..', 'src', 'index.js'), host)
console.log('built ' + out + ' (' + bundle.length + ' chars, ' + MODULES.length + ' modules)')
console.log('built ' + host)