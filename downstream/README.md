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

Current status: migration. The lock, release manifest, governance verify, package build, and `apply` delegation are real; package migration is 19/27; release-manifest.localPackages identifies the workspace overrides the image builder must prefer; `verify --strict-local` rejects local/profile pin mismatches; the image builder remains fail-closed. See `PLUS-MONOREPO-GOVERNANCE.md` and `BUILD.md`.
