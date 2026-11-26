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

The workspace image under `images/workspace/` reads `dsh-src.tar.gz`, the Plus distribution tarball and six `vendor/` tarballs from its build context. A clean clone materializes and verifies them before resolving the three-layer build plan:

```bash
git clone --depth 1 git@github-sparkelf:SparkElf/deepseek-harness-plus.git /tmp/plus-clean-fork
cd /tmp/plus-clean-fork
CI=true pnpm install --frozen-lockfile
pnpm run build
images/workspace/scripts/prepare-inputs.sh
images/workspace/scripts/build-workspace-final.sh 0.2.9-alpha.106 --print
```

Without `DATAOPS_WORKSPACE_DIR` the script uses public sources: a depth-1 fetch of `DSH_SOURCE_REVISION` packed with its `.git` (`dsh-plus apply` runs `git rev-parse HEAD` and `git apply --3way`), `pnpm --filter @sparkelf/dsh-plus pack`, and downloads of the six vendor tarballs from npm and the SheetJS CDN. `--check` verifies the files in the context without writing; `--dataops <dir>` forces the fast path.

Measured on 2026-11-26 from the local DataOps checkout:

```text
prepare-inputs.sh                EXIT 0, 10.5s
  dsh-src                        HEAD 4b399c39a6d1479cd84ca591b4d7c88e24d38a96
  plus                           @sparkelf/dsh-plus@0.2.9-alpha.106
  vendor                         6 files match inputs.lock.json
build-workspace-final --print    all declared inputs present
```

The public path was exercised with `DSH_SOURCE_REPOSITORY=file:///root/projects/deepseek-harness-plus` because the canonical GitHub URL was unreachable from this host. The generated archive passed the exact `dsh-plus apply` preflight (`git read-tree HEAD`, then `git apply --cached --3way` for all 23 source patches in manifest order), and all six vendor tarballs matched `images/workspace/inputs.lock.json`. The image itself was not rebuilt.
