import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: false,
  entry: ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/bin.js'],
  dts: false,
  external: [/^[^./]/],
  fixedExtension: false,
  format: 'esm',
  outDir: 'lib',
})
