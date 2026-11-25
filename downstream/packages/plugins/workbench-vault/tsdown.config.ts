import type { UserConfig } from 'tsdown'

const config: UserConfig = { entry: { index: 'src/index.ts' }, outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: true, clean: true }

export default config
