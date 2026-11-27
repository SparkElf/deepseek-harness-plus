/** Build the Host ESM entry and the browser module-loader bundle. */

import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@sparkelf/dsh-dataops-im'

/**
 * Specifiers the DSH module table can resolve.
 *
 * Must stay a subset of DSH's own `PLATFORM_MODULES`: a word the table does not hold fails at
 * runtime with `require("x") missed the module table`, and the whole plugin is reported as failed
 * to load rather than as a missing panel. Everything else is inlined.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const node: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // The Host bundle ships as one file into a profile that carries the platform's own modules but
  // not this package's dependencies, so anything not provided by the platform must be inside.
  noExternal: (id: string) => (id.startsWith('@deepseek-ai/') || id === '@xmanrui/dsh-im' ? undefined : true),
}

const client: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
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
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [node, client] satisfies UserConfig[]