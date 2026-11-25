import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const ID = '@sparkelf/dsh-sql-workbench'
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url))
const EXTERNALS = ['react', 'react/jsx-runtime', '@deepseek-ai/cordis']
const CSS_VIRTUAL_PREFIX = '\0dsh-sql-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** 将 CSS Modules 编译进单文件客户端 bundle，并在插件激活时挂载样式。 */
function cssModulesPlugin() {
  return {
    name: 'dsh-sql-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const absolute = importer === undefined ? source : resolvePath(dirname(importer), source)
      return CSS_VIRTUAL_PREFIX + relative(PROJECT_ROOT, absolute).replaceAll('\\', '/') + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const stableId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const fileId = resolvePath(PROJECT_ROOT, stableId)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const result = transform({
        filename: stableId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, value]) => [key, value.name]))
      const tagId = ID + '/' + basename(fileId)
      return [
        'const css = ' + JSON.stringify(result.code.toString()) + ';',
        'const tagId = ' + JSON.stringify(tagId) + ';',
        "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
        "  const tag = document.createElement('style');",
        '  tag.dataset.plugin = ' + JSON.stringify(ID) + ';',
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        'export default ' + JSON.stringify(classMap) + ';',
      ].join('\n')
    },
  }
}

const host: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  outputOptions: { entryFileNames: '[name].js' },
}

const client: UserConfig = {
  name: ID + '/client',
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  minify: true,
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: EXTERNALS,
    alwaysBundle: (id: string) => !EXTERNALS.includes(id),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [cssModulesPlugin()],
  outputOptions: {
    entryFileNames: 'client.js',
    codeSplitting: false,
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [host, client]
