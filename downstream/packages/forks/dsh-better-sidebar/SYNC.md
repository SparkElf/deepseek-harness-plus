# Syncing `@sparkelf/dsh-better-sidebar`

- Upstream: `SparkElf/DSH-better-sidebar`, branch `main`, synced at
  `3b2a8ded762b78719853aed5e6d7b907ce015006` (0.30.1-sparkelf.21).
- Published target: 0.30.1-sparkelf.22. The .22 release commit was never pushed;
  `src/context-types.ts` and `src/index.ts` were taken from the published tarball.
- Sync steps:
  1. `git clone git@github-sparkelf:SparkElf/DSH-better-sidebar.git /tmp/bs`
  2. diff `/tmp/bs/src` against this tree, keeping the DSH 0.2.3 `connection.admit`
     compatibility fence in `src/index.ts`.
  3. carry the version bump and the two published source files forward if `main`
     still stops at .21.
  4. update `upstream.json`, run `pnpm --filter @sparkelf/dsh-better-sidebar run build`.
- Do not copy `lib/`, `node_modules/`, `pnpm-lock.yaml`, or `pnpm-workspace.yaml`.
