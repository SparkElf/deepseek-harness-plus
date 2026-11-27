# Syncing `@sparkelf/dsh-quant`

- Upstream: `SparkElf/dsh-quant-plus`, branch `main`, synced at
  `803bd0b31c70609f46599b5e2ded0e5e4b5ac4fa` (0.91.0-sparkelf.13).
- Published target: 0.91.0-sparkelf.14. The .14 npm tarball differs from .13 only
  in `package.json` (version and DSH/cordis peer ranges); the source tree is unchanged.
- Sync steps:
  1. `git clone git@github-sparkelf:SparkElf/dsh-quant-plus.git /tmp/quant`
  2. diff `/tmp/quant` against this tree, excluding `.git`, lockfiles, and `lib/`.
  3. compare the published `package.json` for peer-range changes and bump the
     version to the next `-sparkelf.N`.
  4. update `upstream.json`, run `pnpm --filter @sparkelf/dsh-quant run build`.
- Do not copy `node_modules/`, `pnpm-lock.yaml`, or `pnpm-workspace.yaml`.
