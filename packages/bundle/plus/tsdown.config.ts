import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/apply.js', 'lib/types/bin.js'],
  dts: false,
  clean: false,
  fixedExtension: false,
  external: [/^[^./]/],
  format: 'esm',
  outDir: 'lib',
})
