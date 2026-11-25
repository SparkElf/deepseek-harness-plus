import type { UserConfig } from 'tsdown'

const config: UserConfig = {
  entry: {
    index: 'src/index.ts',
    invariant: 'src/invariant.ts',
    bin: 'src/bin.ts',
  },
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
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-invariants',
      '@deepseek-ai/dsh-session',
      'yaml',
    ],
  },
}

export default config
