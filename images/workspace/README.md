# Workspace image build

English | [中文](README.zh.md)

Status: skeleton of the DataOps AI workspace image build, moved from `dataops/infra/docker-workspace` under task B-08. The Dockerfiles, build scripts and build-time inputs are mirrored byte-for-byte, and the build plan resolves. A clean clone materializes the untracked inputs with `scripts/prepare-inputs.sh`; a full build still needs Docker and the base image. DataOps still owns the production build; nothing here is deployed.

## Layout

```text
images/workspace/
├── README.md                  this file
├── inputs.lock.json           digests of the mirror and of the artifacts a build must supply
├── context/                   docker build context, mirrors infra/docker-workspace
│   ├── Dockerfile             base layer (Node 26 + Python 3.12 + LibreOffice + Playwright)
│   ├── Dockerfile.plus-cli-src  plus-inputs + source-build + plus-build
│   ├── Dockerfile.runtime-cli   runtime layer
│   ├── apply-plus.sh          phased source patches/build and profile install
│   ├── runtime-prune.sh       optional build-only prune (RUNTIME_PRUNE=1)
│   └── ...                    scripts and inputs copied by those three files
├── scripts/
│   ├── build-workspace-final.sh  three-layer build entry
│   ├── build-plus-staged.sh      source-build / plus-build measurement entry
│   ├── prepare-inputs.sh         supply and verify the untracked build artifacts
│   └── check-parity.sh           digest comparison against the DataOps source tree
└── acceptance/
    ├── baseline-20261126.json    B-07 measurements, targets, and unmeasured items
    └── verify-workspace-image.mjs  boot and plugin acceptance probe
```

Copied paths keep their DataOps names so every `COPY` in the Dockerfiles resolves without editing the build definitions. A later step renames them to the `Dockerfile.base` / `Dockerfile.plus` / `Dockerfile.runtime` layout in the ownership design; renaming now would trade byte-identical parity for naming, and the parity check is what makes a duplicated context safe.

| DataOps path | Here |
| --- | --- |
| `infra/docker-workspace/Dockerfile` | `context/Dockerfile` |
| `infra/docker-workspace/Dockerfile.plus-cli-src` | `context/Dockerfile.plus-cli-src` |
| `infra/docker-workspace/Dockerfile.runtime-cli` | `context/Dockerfile.runtime-cli` |
| `infra/docker-workspace/build-workspace-final.sh` | `scripts/build-workspace-final.sh` |
| `infra/docker-workspace/verify-workspace-image.mjs` | `acceptance/verify-workspace-image.mjs` |
| `infra/docker-workspace/*.sh`, `*.py`, `*.mjs`, `profile-defaults/`, `officecli/` | `context/` at the same relative paths |

## Build chain

```text
base            Dockerfile --target workspace-base
                Python 3.12 + Node 26.13.1 + npm 12 + LibreOffice 25.8.7
                + Playwright 1.57.0/Chromium r1200 + OfficeCLI + Python libraries
  -> source-deps  Dockerfile.plus-cli-src stage 1: unpack dsh-src.tar.gz, pnpm install
  -> plus-inputs  Plus tarball metadata edits and global install
  -> source-build apply-plus.sh --phase source: patches -> one official build -> marker
  -> plus-build   apply-plus.sh --phase profile: profile install/link, no rebuild
                  (the final stage keeps the existing name and tags)
  -> runtime      Dockerfile.runtime-cli: entrypoint, workspace gateway, dataops-dsh-service, sshd
  -> final-YYYYMMDD-HHMM, plus final and local aliases
```

The base installs no DSH package. The profile is assembled once, in `plus-build`, and the runtime layer only adds runtime files; a gateway or entrypoint change does not rebuild the DSH tree. `base` carries LibreOffice so a Plus rebuild reuses that layer instead of downloading 790MB again.

## Build

```bash
cd images/workspace

# Resolve every command and list missing inputs; never builds.
./scripts/prepare-inputs.sh
./scripts/build-workspace-final.sh 0.2.9-alpha.106 --print

# Full build, once the eight inputs are supplied.
./scripts/build-workspace-final.sh 0.2.9-alpha.106
```

The script chains the layers by image ID, passes `--network host`, and writes `dataops-ai-workspace:base-py312`, `:plus-cli-py312-<version>`, `:runtime-files`, `:final-<stamp>`, `:final` and `:local`. Set `IMAGE_REPOSITORY` to build under another name.

| Variable | Meaning |
| --- | --- |
| `WORKSPACE_GATEWAY_PROTOCOL_CONTEXT` | DataOps `packages/workspace-web-gateway-protocol`, passed as the named build context `workspace-web-gateway-protocol`; falls back to `DATAOPS_WORKSPACE_DIR/packages/workspace-web-gateway-protocol` |
| `DSH_PLUS_TARBALL` | Plus distribution tarball; defaults to `context/sparkelf-dsh-plus-<version>.tgz` |
| `DSH_SOURCE_REVISION` | Official DSH revision the source tarball was cut from |
| `DSH_SOURCE_REGISTRY`, `DSH_PLUS_INSTALL_REGISTRY` | npm mirrors for the source install and the Plus install |
| `DATAOPS_PROFILE_DEFAULTS` | Provider catalog: `cordis.patch.yml` for the cloud image, `cordis.local-qwen.patch.yml` for the self-hosted arm box |
| `SKIP_BASE=1` | Reuse the existing `base-py312` image for a DSH-only upgrade |
| `RUNTIME_PRUNE=1` | Optional final-phase prune of the build-only paths in `RUNTIME-PRUNE.md`; default `0` |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | Forwarded to the Plus stage |

## Cache

`source-deps` is a real cache boundary: it depends only on `dsh-src.tar.gz`, the lockfile and the vendored `xlsx` tarball, so a Plus pin change reuses the 2.46GB install layer. Six BuildKit cache mounts keep package stores out of image layers:

| Cache id | Path | Used by |
| --- | --- | --- |
| `dsh-pnpm-store` | `/root/.local/share/pnpm/store` | source-deps, plus-build |
| `dsh-pnpm-meta` | `/root/.cache/pnpm` | source-deps, plus-build |
| `dsh-npm-cache` | `/root/.npm` | Plus global install, apply |
| `dataops-workspace-npm` | `/root/.npm` | base npm stage, Playwright |
| `dataops-workspace-pip` | `/root/.cache/pip` | base Python packages |
| `dataops-sidecars-npm` | `/root/.npm` | sidecar install |

The caches are host-local. There is no `docker buildx bake`, no registry cache and no multi-architecture build definition; a different machine starts cold. See the [migration gap record](../../docs/workspace-image-migration-gap.md).

## Acceptance

Measure sizes with one stated method: `docker images` visible size is the number the design documents use, `docker history` sums layer diffs, and `inspect .Size` approximates pull size. A candidate must stay at or below the production row; the latest-build row proves the 2026-11-25 reductions survive.

| Metric | Target | Baseline 2026-11-26 |
| --- | --- | --- |
| Final image, `docker images` | <= 13.2GB (production), soft 11.9GB | 13.2GB production, 11.9GB latest build |
| Plus layer delta | >= 700MB below the pre-LibreOffice-move build | 11.5GB plus, 4.84GB base |
| Writable layer | < 50MB, measured after excluding `/tmp/dsh-workspace-changes-*` | 2.2GB, about 2.09GB of it runtime `/tmp` |
| Per-user `/workspace` volume | < 2GB | 3.2GB |
| Pin-only build | <= 5min; `--skip-build` is implemented, stage timings still unmeasured | split implemented, pin-only path unmeasured |
| Source/patch build | <= 15min warm | unmeasured |
| Base build | <= 25min warm | unmeasured |
| DSH ready | 10-15s warm, 30-60s cold | unmeasured |
| Runtime probe | `node -v` v26.13.1, LibreOffice 25.8.7.3, DSH 0.2.3-alpha.2, Plus 0.2.9-alpha.105, 26 bundles, 19 CJK fonts, `dataops-dsh-service status` ready | matches on the production container |

`acceptance/verify-workspace-image.mjs` starts a temporary container, checks boot, plugin membership and routes, then removes it. `acceptance/baseline-20261126.json` holds the full numbers, the three size methods, and the items that were never measured.

## What DataOps still owns

- The deployment image reference: `DATAOPS_AI_WORKSPACE_DOCKER_IMAGE` / `operations_workspace_hosts.workspace_image`.
- The `/workspace` named volume, port `3080`, the container network, and the runtime overlay mount.
- Portal-side `ensure` / `health` / `restart` for a workspace, and the admin tunnel policy that decides when sshd is reachable.
- Runtime configuration and secrets: model credentials, tenant overrides, the internal token under `/run/dataops-workspace`.
- Rollback tags, release approval, registry push, and the 3000 switch and rollback drill.

## Context artifacts

`inputs.lock.json` is the digest authority for both halves: the mirrored files and the artifacts a build must supply. `scripts/prepare-inputs.sh` supplies the DSH source tarball, the Plus tarball and the six `vendor/` tarballs under `context/` from `DATAOPS_WORKSPACE_DIR` or from public sources, and verifies them; `--check` verifies without writing. The OfficeCLI engine binaries are optional because the engine stage downloads and verifies them.

## Parity during migration

```bash
./scripts/check-parity.sh --dataops /root/projects/dataops/infra/docker-workspace
```

The check compares every mirrored file by content and reports the six artifacts that must stay absent. Until B-10 deletes the DataOps build implementation, any change to a mirrored file has to land on both sides in the same change; the check is what makes that rule enforceable rather than aspirational.

The G6/G7 files (`context/apply-plus.sh`, `context/Dockerfile.plus-cli-src`,
`context/runtime-prune.sh`) are intentionally ahead of the DataOps mirror: the production build is
not modified by this change. `check-parity.sh` reports those diffs until the same files are synced
into `dataops/infra/docker-workspace`.