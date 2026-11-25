/** Build the Host ESM entry and the browser module-loader bundle. */
import { builtinModules } from 'node:module'
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@sparkelf/dsh-task-bus'

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
  ...builtinModules.map((id) => 'node:' + id),
])

const node: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: false,
  noExternal: (id: string) => (id.startsWith('@deepseek-ai/') ? undefined : true),
}

const client: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: CLIENT_EXTERNALS,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [{
    name: 'task-bus-client-purity',
    resolveId(source: string) {
      if (NODE_BUILTINS.has(source)) throw new Error('client bundle cannot include Node builtin ' + source)
      if (source.startsWith('@deepseek-ai/') && !CLIENT_EXTERNALS.includes(source)) {
        throw new Error('client bundle cannot import non-platform package ' + source)
      }
      return null
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [node, client] satisfies UserConfig[]