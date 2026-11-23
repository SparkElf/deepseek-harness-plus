import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js'],
  dts: false,
  clean: false,
  fixedExtension: false,
  external: [/^[^./]/],
  format: 'esm',
  outDir: 'lib',
})
