# Bake entry for the workspace image

`docker-bake.hcl` defines the same three release layers as `scripts/build-workspace-final.sh`:

| Bake target | Dockerfile | Tags | Reads |
| --- | --- | --- | --- |
| `base` | `context/Dockerfile`, target `workspace-base` | `<repo>:base-py312` | node/python base images |
| `plus` | `context/Dockerfile.plus-cli-src` | `<repo>:plus-cli-py312-<version>`, `<repo>:runtime-files` | `<repo>:base-py312` |
| `runtime` | `context/Dockerfile.runtime-cli` | `<repo>:final-bake` | `<repo>:plus-cli-py312-<version>`, `<repo>:runtime-files` |

`source-build` is an intermediate target for a source-only rebuild; nothing in the chain consumes
its tag.

Bake cannot order these targets. Each one reads the previous layer by tag, and `depends_on` is a
compose-file field that the HCL loader ignores: a target with `depends_on` builds alone, and a group
containing all three builds them concurrently, so `plus` would look for `base-py312` before it
exists. `scripts/build-workspace-bake.sh` is the sequential driver. It builds `base`, `plus`, and
`runtime` in that order, records per-stage seconds and image facts, and writes the bake candidate
binding.

The shell entry remains the release path: it chains layers by image ID, tags `final-<stamp>`,
`final`, and `local`, and writes `acceptance/release-binding.json`. Bake never writes those tags.

## Commands

Run from `images/workspace`; `context` and the named gateway context resolve relative to that
directory.

```bash
cd images/workspace

# Resolve every target and print the build definition; builds nothing.
docker buildx bake --print

# Full chain: base -> plus -> runtime, sequential, with a build report and candidate binding.
./scripts/build-workspace-bake.sh

# Plan only: print the resolved targets, tags, and missing inputs.
./scripts/build-workspace-bake.sh --print

# One target. The two tags it reads must already exist locally.
docker buildx bake --allow=network.host base --load
docker buildx bake --allow=network.host plus --load
docker buildx bake --allow=network.host runtime --load
```

Every target sets `network = "host"` to match the shell entry's `docker build --network host`.
buildx 0.30 requires the explicit `--allow=network.host` grant before it runs those build
containers; without it the build stops with `ERROR: additional privileges requested`.

The default group contains only `runtime`. A bare `docker buildx bake` therefore builds the final
layer against whatever `base-py312` and `plus-cli-py312-<version>` tags already exist; it does not
build the chain.

The default repository is `dataops-ai-workspace-candidate`, and no tag is ever pushed. A production
repository must be named explicitly:

```bash
IMAGE_REPOSITORY=registry.example.com/dataops/workspace-candidate ./scripts/build-workspace-bake.sh
```

## Release binding

The driver writes `acceptance/release-binding-bake.json`; the shell entry keeps
`acceptance/release-binding.json`. The two records name different images and different build
entries (`build.script`), and neither overwrites the other.

`image` records both digest layers:

- `localRepoDigest` is always the repo digest Docker stores for the local image. For a local build
  it equals the image config digest (`imageId`); it is reproducible only when a rebuild produces
  the same config.
- `digest`, `digestSource`, and `digestKind` name the authoritative digest. Without a push they
  are the local repo digest with `pushed: false`.
- `--pushed` is accepted only for a registry-qualified repository and only when Docker already
  stores a repo digest whose value differs from the local image id. That value is a registry
  manifest digest; a local config digest is never promoted to one.
- `verify --require-registry` re-queries the exact recorded digest with
  `docker buildx imagetools inspect`. A pushed binding therefore fails verification when the
  registry cannot confirm the digest.

This host has no registry credentials, so the bake binding is written with `pushed: false`. The
local digest is evidence of the bytes in this Docker store, not of a registry manifest:

```bash
node scripts/release-binding.mjs verify \
  --path acceptance/release-binding-bake.json \
  --image dataops-ai-workspace-candidate:final-bake \
  --require-inputs --require-image
```

## Registry cache

No cache is configured by default. `REGISTRY_CACHE` is an opt-in layer-cache namespace, not an
image destination:

```bash
REGISTRY_CACHE=registry.example.com/dataops/workspace-cache ./scripts/build-workspace-bake.sh
```

That writes `cache-to` metadata under `<REGISTRY_CACHE>/{base,plus,runtime}` and reads it back on
the next host. It does not push an image. Pushing is a separate explicit operation and needs a
registry-qualified repository:

```bash
docker buildx bake --push --allow=network.host \
  --set IMAGE_REPOSITORY=registry.example.com/dataops/workspace-candidate runtime
```

The six BuildKit cache mounts in the Dockerfiles (`dsh-pnpm-store`, `dsh-pnpm-meta`,
`dsh-npm-cache`, `dataops-workspace-npm`, `dataops-workspace-pip`, `dataops-sidecars-npm`) stay
host-local; a registry cache shares layers, not those mounts. A cold second host still pays the
first `pnpm install`; the cold baseline is 2.46GB for `source-deps` and 1.11–1.68GB for the Plus
layer.

## Measured build

2026-11-26, `linux/amd64`, Docker 28.3.2 / buildx 0.30.1, `DSH_PLUS_VERSION=0.2.9-alpha.106`.
The candidate `base-py312` tag moved from the shell-chain image (`f1df081bbad7`) to the bake image
below; the shell-chain final image and its `final`/`local` tags were not touched.

| Stage | Cache | Seconds | Image ID | `inspect .Size` | Layers |
| --- | --- | --- | --- | --- | --- |
| base | cold (first bake run) | 1042 | `sha256:aff4ffcf254b…` | 1,316,008,258 | 16 |
| base | warm | 2 | `sha256:5ae1bc4e0466…` | 1,316,006,178 | 16 |
| plus | cold | failed after ~600 (the failing RUN took 590.7) | — | — | — |
| runtime | not attempted | — | — | — | — |

The `plus` target failed at `context/Dockerfile.plus-cli-src:247`, the
`apply-plus.sh --phase source` RUN:

```
missing build marker: /opt/dsh-source/.dataops-official-build.json
ERROR: failed to solve: process "/bin/sh -c bash /usr/local/bin/apply-plus.sh --phase source"
did not complete successfully: exit code: 1
```

`apply-plus.sh` (the phased-apply change in `790287dbae`) asserts the marker after
`cleanup_build_only`, but the pinned `@sparkelf/dsh-plus@0.2.9-alpha.106` apply run did not leave
one at that path in this build. The shell chain built the same version seven hours earlier with the
pre-phased script, so this is a source-phase blocker, not a bake argument difference. No
`final-bake` image was produced, so there is no bake binding or digest for this run. Fix the
producer/consumer pair, then rerun only `./scripts/build-workspace-bake.sh --skip-base`. The previous `plus-cli-py312-0.2.9-alpha.106` and
`runtime-files` tags still name the shell-chain image `e35a002df712`.

Reference shell chain, same version: base `f1df081bbad7` 1,316,006,178 B / 16 layers, plus
`e35a002df712` 2,821,941,464 B / 82 layers, final `aec6ff25db3d` 2,909,582,424 B / 110 layers,
built in three `docker build` calls.

The warm base run produced the shell-chain size but a new image ID: the docker driver writes a new
config timestamp on export even when every layer is cached. Image IDs are not reproducible across
runs; layer count, per-layer size, and the recorded input digest are the comparable facts.

## Boundaries

- `runtime` tags `final-bake`, never `final` or `local`. A bake run cannot overwrite a rollback tag
  by accident.
- A bare bake target has no post-build hook. Only `scripts/build-workspace-bake.sh` writes the bake
  candidate binding.
- Multi-architecture output is not validated. Several stages download architecture-specific
  assets; set one platform at a time until an arm64 acceptance run exists.