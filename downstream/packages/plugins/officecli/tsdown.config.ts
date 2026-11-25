import type { UserConfig } from 'tsdown'

const config: UserConfig = {
  // `office-kit-bridge` is also its own entry so a profile hot patch can copy the loopback
  // bridge without rebuilding the whole plugin bundle.
  entry: { index: 'src/index.ts', 'office-kit-bridge': 'src/office-kit-bridge.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-skill',
    ],
  },
}

export default config
