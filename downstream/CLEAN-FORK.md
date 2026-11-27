# Clean-fork image evidence

Verified from a shallow clone of `SparkElf/deepseek-harness-plus` on 2026-11-26:

```bash
git clone --depth 1 git@github-sparkelf:SparkElf/deepseek-harness-plus.git /tmp/plus-clean-fork
cd /tmp/plus-clean-fork
CI=true pnpm install --frozen-lockfile
pnpm run build
node downstream/tools/downstream.mjs build-packages
node downstream/tools/downstream.mjs verify --strict-local
node downstream/tools/downstream.mjs image --tag dataops-web-profile:clean-fork --smoke
```

Results:

```text
install              EXIT 0
full build           EXIT 0
build-packages       EXIT 0
verify --strict      EXIT 0
image --smoke        smoke: http=401
image tag            dataops-web-profile:clean-fork
```

The 401 is the DSH auth page: the image boots the CLI, loads the generated
profile, resolves every profile bundle, and listens on 3080. Production
overlays (DataOps gateway, auth, volumes, secrets) remain external.

## Workspace image inputs

The workspace image under `images/workspace/` reads `dsh-src.tar.gz`, the Plus distribution tarball and six `vendor/` tarballs from its build context; the xlsx tarball has a byte-identical tracked seed under `images/workspace/seed/`. A clean clone materializes and verifies them before resolving the three-layer build plan:

```bash
git clone --depth 1 git@github-sparkelf:SparkElf/deepseek-harness-plus.git /tmp/plus-clean-fork
cd /tmp/plus-clean-fork
CI=true pnpm install --frozen-lockfile
pnpm run build
images/workspace/scripts/prepare-inputs.sh
images/workspace/scripts/build-workspace-final.sh 0.2.9-alpha.106 --print
```

Without `DATAOPS_WORKSPACE_DIR` the script uses public sources: a depth-1 fetch of `DSH_SOURCE_REVISION` packed with its `.git` (`dsh-plus apply` runs `git rev-parse HEAD` and `git apply --3way`), `pnpm --filter @sparkelf/dsh-plus pack`, a copy of the tracked `images/workspace/seed/xlsx-0.20.3.tgz` verified against `inputs.lock.json`, and downloads of the other five vendor tarballs from npm. The SheetJS CDN is used only when that seed is missing or does not match the lock. `--check` verifies the files in the context without writing; `--dataops <dir>` forces the fast path.

Measured on 2026-11-26 from the local DataOps checkout:

```text
prepare-inputs.sh                EXIT 0, 10.5s
  dsh-src                        HEAD 4b399c39a6d1479cd84ca591b4d7c88e24d38a96
  plus                           @sparkelf/dsh-plus@0.2.9-alpha.106
  vendor                         6 files match inputs.lock.json
build-workspace-final --print    all declared inputs present
```

The public path was exercised with `DSH_SOURCE_REPOSITORY=file:///root/projects/deepseek-harness-plus` because the canonical GitHub URL was unreachable from this host. The generated archive passed the exact `dsh-plus apply` preflight (`git read-tree HEAD`, then `git apply --cached --3way` for all 23 source patches in manifest order), and all six vendor tarballs matched `images/workspace/inputs.lock.json`. The image itself was not rebuilt.

## xlsx seed on the public path

Verified on 2026-11-27 from a copy of `images/workspace` at `/tmp/xlsx-public-test`, with a `curl`
shim that rejects `cdn.sheetjs.com`, `DSH_SOURCE_REPOSITORY=file:///root/projects/deepseek-harness-plus`
for the source fetch, and the existing Plus tarball supplied through `DSH_PLUS_TARBALL`:

```text
prepare-inputs.sh --public     EXIT 0
  repo-seed: context/vendor/xlsx-0.20.3.tgz from seed/xlsx-0.20.3.tgz
  xlsx                         source: repo-seed
  vendor                       6 files match inputs.lock.json
  SheetJS CDN requests         0
```

The other five vendor tarballs still downloaded from `registry.npmjs.org`. Corrupting the seed in
the test copy made the script fall back to the CDN; the repacked tarball still matched
`sha256 275220ad69ba7721886e274d3a635ef5b04a9404cf0019f631bc19b8faa05c2a` and `2412635` bytes.

## G13 clean-clone governance replay

Verified on 2026-11-27 from `/tmp/plus-clean-g13`, a clean local clone of this repository
after `pnpm install --frozen-lockfile` and a full repository build:

```text
downstream verify       EXIT 0
  upstream lock / release manifest / Plus governance consistent
downstream doctor       EXIT 0
  release-manifest reproducible-sane, 27 workspace build-artifact warnings
downstream image-plan   EXIT 0
  digest sha256:19823e1e6054cfbd8e519b0a863e5f7e5d8a41dcf0ee517b35f636db03b8fe78
  inputs 59 exact profile dependencies
```

The image-plan digest matches the current working tree, so the clean clone resolves the same
release-manifest input set. The same clone built `dataops-ai-workspace-clean-g13:final`
(11.8GB, 113 layers) and passed the workspace acceptance script 91/91.
