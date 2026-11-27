# Syncing `@sparkelf/dsh-genui`

- Upstream: `SparkElf/dsh-genui`, branch `main`, synced at
  `5dcce64b9cc68244118171eb87b376c19fe26b11` (0.15.0-sparkelf.3).
- Published target: 0.15.0-sparkelf.3; the tarball package.json is identical to
  the repository.
- Sync steps:
  1. `git clone git@github-sparkelf:SparkElf/dsh-genui.git /tmp/genui`
  2. diff `/tmp/genui` against this tree, excluding `.git`, lockfiles, and `lib/`.
  3. update `upstream.json`, run `pnpm --filter @sparkelf/dsh-genui run build`.
- Do not copy `node_modules/`, `pnpm-lock.yaml`, or `pnpm-workspace.yaml`.
