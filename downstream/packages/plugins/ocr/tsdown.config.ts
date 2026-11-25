/** Build the Host ESM entry and the browser module-loader bundle. */

import { builtinModules } from 'node:module'

import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@sparkelf/dsh-ocr'

/**
 * Specifiers the loader's module table can resolve.
 *
 * This list must stay a subset of DSH's own `PLATFORM_MODULES`: those are the words the
 * module table is seeded with. An entry the table does not hold fails at RUNTIME rather than
 * at build time, with `require("x") missed the module table` in the browser and the whole
 * plugin reported as failed to load.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(id => 'node:' + id),
])

type BuildPlugin = NonNullable<UserConfig['plugins']>

/**
 * Reject Node builtins and non-platform packages from the browser bundle.
 *
 * The guard runs at build time because the alternative is a runtime failure inside the
 * shell's module loader, where the whole plugin reads as "failed to load" with no
 * indication of which import caused it.
 */
function purityGate(): BuildPlugin {
  return {
    name: 'dsh-ocr-client-purity',
    resolveId(source: string) {
      if (NODE_BUILTINS.has(source)) throw new Error('client bundle cannot include Node builtin ' + source)
      if (source.startsWith('@deepseek-ai/') && !CLIENT_EXTERNALS.includes(source)) {
        throw new Error('client bundle cannot import non-platform package ' + source)
      }
      return null
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
  plugins: [purityGate()],
  outputOptions: {
    entryFileNames: 'client.js',
    // The Web shell loads a client plugin through its own module table rather than an ES
    // import: this wrapper is the contract every third-party client bundle uses.
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [node, client] satisfies UserConfig[]
