/** Build the Host ESM entry and the browser module-loader bundle. */

import { readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const PLUGIN_ID = '@sparkelf/dsh-dataops-integration'
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(id => 'node:' + id),
])

type BuildPlugin = NonNullable<UserConfig['plugins']>

function purityGate(): BuildPlugin {
  return {
    name: 'dsh-dataops-client-purity',
    resolveId(source: string) {
      if (NODE_BUILTINS.has(source)) throw new Error('client bundle cannot include Node builtin ' + source)
      if (source.startsWith('@deepseek-ai/') && !CLIENT_EXTERNALS.includes(source)) {
        throw new Error('client bundle cannot import non-platform package ' + source)
      }
      return null
    },
  }
}

function cssModules(): BuildPlugin {
  return {
    name: 'dsh-dataops-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const absolute = importer === undefined ? source : resolvePath(dirname(importer), source)
      return CSS_VIRTUAL_PREFIX + absolute + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, value] of Object.entries(cssExports ?? {})) classMap[local] = value.name
      const tagId = PLUGIN_ID + '/' + basename(fileId)
      return [
        'const css = ' + JSON.stringify(code.toString()) + ';',
        'const tagId = ' + JSON.stringify(tagId) + ';',
        "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
        "  const tag = document.createElement('style');",
        '  tag.dataset.plugin = ' + JSON.stringify(PLUGIN_ID) + ';',
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        'export default ' + JSON.stringify(classMap) + ';',
      ].join('\n')
    },
  }
}

const node: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

const client: UserConfig = {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: CLIENT_EXTERNALS,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  inputOptions: {
    resolve: {
      conditionNames: ['browser', 'import', 'require', 'default'],
      mainFields: ['browser', 'module', 'main'],
    },
  },
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [purityGate(), cssModules()],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [node, client] satisfies UserConfig[]
