import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  dts: false,
  external: [/^[^./]/],
  format: 'esm',
  outDir: 'lib',
})
