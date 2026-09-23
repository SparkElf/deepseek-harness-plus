import { defineConfig } from 'tsdown'

/**
 * The DataOps standalone package's Host pass.
 *
 * The root workspace build emits \`lib/index.js\` from the shared entry pattern; this
 * package also ships the installed command, which the root pattern does not name.
 * A package-local config adds that one entry while leaving the shared one alone.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/bin.js'],
  dts: false,
  clean: false,
  fixedExtension: false,
  external: [/^[^./]/],
  format: 'esm',
  outDir: 'lib',
})
