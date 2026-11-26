# Bake entry for the workspace image

`docker-bake.hcl` defines the same three layers as `scripts/build-workspace-final.sh`:

| Bake target | Dockerfile | Tags | Depends on |
| --- | --- | --- | --- |
| `base` | `context/Dockerfile`, target `workspace-base` | `<repo>:base-py312` | — |
| `plus` | `context/Dockerfile.plus-cli-src` | `<repo>:plus-cli-py312-<version>`, `<repo>:runtime-files` | `base` |
| `runtime` | `context/Dockerfile.runtime-cli` | `<repo>:final-bake` | `plus` |

The shell entry remains the release path: it chains layers by image ID, writes the candidate
release binding, and is what the acceptance record names. Bake is for CI and a second host that
need the same arguments, target selection, platform, and a shared layer cache without copying
shell code.

## Commands

Run from `images/workspace`; `context` and the named gateway context resolve relative to that
directory.

```bash
cd images/workspace

# Resolve every target and print the build definition; builds nothing.
docker buildx bake --print

# Build one target. Dependencies are built first when the tag is still missing.
docker buildx bake base
docker buildx bake plus
docker buildx bake runtime

# Build the default group: base -> plus -> runtime.
docker buildx bake

# Build for another platform (the Dockerfiles are only tested on amd64).
docker buildx bake --set '*.platform=linux/arm64'
```

The default repository is `dataops-ai-workspace-candidate`. Override it explicitly; a production
repository is never a default:

```bash
docker buildx bake --set IMAGE_REPOSITORY=registry.example.com/dataops/workspace
```

## Registry cache

No cache is configured by default. `REGISTRY_CACHE` is an opt-in layer-cache namespace, not an
image destination:

```bash
REGISTRY_CACHE=registry.example.com/dataops/workspace-cache docker buildx bake
```

That writes `cache-to` metadata under `<REGISTRY_CACHE>/{base,plus,runtime}` and reads it back on
the next host. It does not push an image. Pushing is a separate explicit operation and needs a
registry-qualified repository:

```bash
docker buildx bake --push --set IMAGE_REPOSITORY=registry.example.com/dataops/workspace
```

The six BuildKit cache mounts in the Dockerfiles (`dsh-pnpm-store`, `dsh-pnpm-meta`,
`dsh-npm-cache`, `dataops-workspace-npm`, `dataops-workspace-pip`, `dataops-sidecars-npm`) stay
host-local; a registry cache shares layers, not those mounts. A cold second host still pays the
first `pnpm install`; the cold baseline is 2.46GB for `source-deps` and 1.11–1.68GB for the Plus
layer.

## Boundaries

- Bake chains by tag (`depends_on`), so the `plus` stage reads `<repo>:base-py312` from the local
  store rather than an image ID. Do not use bake to produce a release-bound candidate; use
  `scripts/build-workspace-final.sh`, which also writes `acceptance/release-binding.json`.
- `runtime` tags `final-bake`, never `final` or `local`. A bake run cannot overwrite a rollback
  tag by accident.
- Multi-architecture output is not validated. Several stages download architecture-specific
  assets; set one platform at a time until an arm64 acceptance run exists.
