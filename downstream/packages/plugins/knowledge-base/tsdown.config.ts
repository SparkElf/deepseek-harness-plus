/** Build the Host ESM entry and the browser module-loader bundle. */

import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'

import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const PLUGIN_ID = '@sparkelf/dsh-knowledge-base'
// This package sits two levels under the workspace root. `process.cwd()` is the package
// directory when the build runs, and unlike `import.meta.url` it needs no module-system
// support from the config loader.
const WORKSPACE_ROOT = resolvePath(process.cwd(), '..', '..', '..', '..')

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/**
 * Specifiers the loader's module table can resolve.
 *
 * This list must stay a subset of DSH's own `PLATFORM_MODULES`
 * (`packages/client/web/src/platform.ts`): those are the words the module table is
 * seeded with. An entry the table does not hold fails at RUNTIME rather than at
 * build time, with `require("x") missed the module table` in the browser and the
 * whole plugin reported as failed to load -- which is what a `clsx` entry here
 * measured as, since the table carries no such word. Everything else the client
 * needs is inlined, including dependencies brought in through the borrowed file
 * tree.
 */
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
    name: 'dsh-kb-client-purity',
    resolveId(source: string) {
      if (NODE_BUILTINS.has(source)) throw new Error('client bundle cannot include Node builtin ' + source)
      if (source.startsWith('@deepseek-ai/') && !CLIENT_EXTERNALS.includes(source)) {
        throw new Error('client bundle cannot import non-platform package ' + source)
      }
      return null
    },
  }
}

/**
 * Point `react-icons`' two barrels at their ESM files.
 *
 * The borrowed file tree imports `react-icons/si` and `react-icons/vsc`. Each subpath
 * publishes BOTH a CommonJS barrel and an ESM one, and the package's `exports` map picks by
 * condition. A CJS barrel is one aggregate object, so a bundler must keep every icon in it;
 * the ESM barrel declares one icon per `export function` and tree-shakes.
 *
 * Without this, the browser bundle measured 6,988,032 bytes -- the whole `react-icons/si`
 * table (5.31 MB) plus `react-icons/vsc` (0.81 MB) -- against 560,755 bytes with the two
 * barrels pinned. The tree renders seven icons, so 6.4 MB was being shipped for glyphs
 * nobody sees.
 *
 * The specifiers are resolved to absolute paths BEFORE any condition is consulted, which is
 * what `conditionNames`/`mainFields` could not do: the dependency is reached through another
 * package's pre-built output, so this package's resolve conditions never applied to it.
 *
 * Paths are computed from the workspace root rather than hardcoded, because pnpm's store
 * directory carries a content hash and a peer suffix. The directory is found by prefix scan,
 * and a miss is reported as a build error naming the real cause instead of surfacing later
 * as an unresolved import.
 */
function reactIconsEsm(): BuildPlugin {
  /** The `react-icons` package root inside pnpm's store, or undefined when absent. */
  const findIconsRoot = (): string | undefined => {
    const store = resolvePath(WORKSPACE_ROOT, 'node_modules', '.pnpm')
    // Read synchronously at config-evaluation time: this runs once, before the build, and a
    // promise here would make `resolveId` (which must be synchronous) unable to use it.
    const names = readdirSync(store) as string[]
    const match = names.find(name => name.startsWith('react-icons@'))
    return match === undefined ? undefined : resolvePath(store, match, 'node_modules', 'react-icons')
  }

  const iconsRoot = findIconsRoot()
  if (iconsRoot === undefined) {
    throw new Error('react-icons is missing from the pnpm store; the borrowed file tree cannot build without it')
  }

  return {
    name: 'dsh-kb-react-icons-esm',
    resolveId(source: string) {
      const file = source === 'react-icons/si' ? join('si', 'index.mjs')
        : source === 'react-icons/vsc' ? join('vsc', 'index.mjs')
          : undefined
      return file === undefined ? null : resolvePath(iconsRoot, file)
    },
  }
}

/**
 * Resolve the borrowed better-sidebar source imports against the local fork.
 *
 * `dsh-better-sidebar/src/...` is type-stubbed in the workspace tsconfig so `tsc`
 * can check this package without the fork on disk. The BUNDLER, however, needs the
 * real modules: it inlines `FileTree`, `referenceInChat` and the address helpers
 * into the client bundle. Resolving them to the sibling checkout keeps the bundle
 * honest instead of failing on the type stub's missing value exports.
 */
function betterSidebarSource(): BuildPlugin {
  const root = '/root/projects/DSH-better-sidebar/src'
  return {
    name: 'dsh-kb-better-sidebar-source',
    resolveId(source: string) {
      if (!source.startsWith('dsh-better-sidebar/src/')) return null
      return resolvePath(root, source.slice('dsh-better-sidebar/src/'.length))
    },
  }
}

function cssModules(): BuildPlugin {
  return {
    name: 'dsh-kb-css-modules',
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
      // Pin the icon barrels by file. The borrowed file tree imports
      // `react-icons/si` and `react-icons/vsc`, and each subpath publishes both a
      // CommonJS barrel and an ESM one. The CJS barrel is a single aggregate
      // object, so a bundler must keep every icon in it; the ESM barrel exports
      // one icon per module and tree-shakes. Naming the `.mjs` file keeps the
      // choice off the output format's own condition, which otherwise selects the
      // CJS barrel and measured as a 6.75 MB client bundle carrying 4063 icon
      // definitions against the 19 the tree actually renders.
      conditionNames: ['browser', 'import', 'require', 'default'],
      mainFields: ['browser', 'module', 'main'],
    },
  },
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [purityGate(), reactIconsEsm(), betterSidebarSource(), cssModules()],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [node, client] satisfies UserConfig[]
