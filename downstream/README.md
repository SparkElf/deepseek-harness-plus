# Downstream monorepo scaffold

This directory is the migration target for the DSH Plus downstream workspace.

```text
upstream.lock.json    official DSH tag/revision
release-manifest.json exact Plus/profile image inputs
packages/plugins/     first-party SparkElf plugins (to be migrated)
packages/forks/       maintained third-party forks (to be migrated)
patches/core/         official-source-only patches
patches/packages/     single-package patches (pnpm patchedDependencies)
profiles/dataops-web/ DataOps web profile composition
tools/downstream.mjs  sync/build-packages/apply/verify/image/publish entry point
```

Current status: scaffold only. The lock, release manifest, and governance verify are real; package build/apply/image remain fail-closed until migration lands. See `PLUS-MONOREPO-GOVERNANCE.md` and `BUILD.md`.
