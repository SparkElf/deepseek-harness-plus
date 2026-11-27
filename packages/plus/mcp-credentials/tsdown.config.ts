import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js'],
  // tsc emits lib/types first; tsdown must not clean it before resolving the entry.
  clean: false,
  dts: false,
  external: [/^[^./]/],
  format: 'esm',
  outExtensions: () => ({ js: '.js' }),
  outDir: 'lib',
})
