/** Build the Host ESM entry that registers the DataOps administration skill. */

import type { UserConfig } from 'tsdown'

const config: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

export default [config] satisfies UserConfig[]
