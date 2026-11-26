# Splitting `apply-plus.sh` into source-build and profile phases

Status: analysis and a precise patch plan. The production chain is unchanged; the implemented
read-only part is `scripts/apply-plus-preflight.sh`, which reports which phases a build would run
and defines the marker a future `--skip-build` must verify.

## Why the current chain cannot skip the official build

`context/apply-plus.sh` runs one `dsh-plus apply` at line 103. That call owns four phases:

| Phase | Owner | Cost driver |
| --- | --- | --- |
| Profile workspace setup and `pnpm install` | `applySelectedPatches` (`apply.ts:734`) | profile install, 805MB result |
| Source patch application (`git apply --3way`) | `applySelectedPatches` | 23 source patches |
| `pnpm install` in the source tree | `applySelectedPatches` | 2.46GB `source-deps` layer is reused, install after patches is not |
| `pnpm run build:official` | `applySelectedPatches` (`apply.ts:755`) | the phase a pin-only rebuild should skip |

`runApply` rebuilds whenever the selected patch set contains any `dsh-source` patch:

```ts
if (materialized.patches.some(patch => patch.target.kind === 'dsh-source')) {
  if (sourceFiles.length > 0) runPnpm(dshRoot, ['install', '--no-frozen-lockfile'], ...)
  runPnpm(dshRoot, ['run', 'build:official'], 'official DSH build after source patches')
}
```

The condition is on the *selection*, not on `pendingSourcePatchFiles`, so a second `apply` against
an already-patched tree still rebuilds. `parseApplyArguments` (`apply.ts:859`) accepts only
`--dsh-root`; there is no `--skip-build` and no profile-only command. A script-only split therefore
cannot avoid the build; it would either duplicate `apply`'s profile work or silently ship stale
`lib/` output.

The patch-set lock (`.dsh-plus/patchset.lock.json`) is written inside the profile directory, which
is created in the same Docker layer as the build. A real two-stage split must copy that lock and the
built source tree into the profile stage, and must prove the build matches the selected patch set.

## Option A — `--skip-build` in the Plus CLI (recommended)

This is the smallest change that preserves one owner for patch/profile semantics. It touches
`packages/bundle/plus/src/apply.ts` and then `context/apply-plus.sh`; `context/apply-plus.sh` is
mirrored, so the DataOps copy must change in the same commit or `check-parity.sh` goes red.

### 1. `apply.ts`

```diff
 interface ApplyArguments {
   dshRoot: string
   profileDirectory: string
+  skipBuild: boolean
 }

 function applySelectedPatches(
   profileDirectory: string,
   dshRoot: string,
   patches: readonly SelectedPatch[],
   profileChanged: boolean,
+  skipBuild: boolean,
 ): void {
@@
   if (materialized.patches.some(patch => patch.target.kind === 'dsh-source')) {
     if (sourceFiles.length > 0) {
       runPnpm(dshRoot, ['install', '--no-frozen-lockfile'], 'pnpm install after source patches')
     }
-    runPnpm(dshRoot, ['run', 'build:official'], 'official DSH build after source patches')
+    if (skipBuild) {
+      assertPrebuiltSource(dshRoot, materialized.patches)
+    } else {
+      runPnpm(dshRoot, ['run', 'build:official'], 'official DSH build after source patches')
+    }
   }
 }
```

`assertPrebuiltSource` checks the marker, the source revision, the patch-set digest, and the built
entry points. The digest is the same one `scripts/apply-plus-preflight.sh` computes:

```ts
function assertPrebuiltSource(dshRoot: string, patches: readonly SelectedPatch[]): void {
  const markerPath = resolve(dshRoot, '.dataops-official-build.json')
  if (!existsSync(markerPath)) throw new Error('--skip-build needs ' + markerPath)
  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
    sourceRevision?: unknown
    patchsetDigest?: unknown
  }
  const sourceRows = patches
    .filter((patch): patch is SelectedSourcePatch => patch.target.kind === 'dsh-source')
    .map(patch => ({
      id: patch.id,
      file: patch.file,
      baseRevision: patch.target.baseRevision,
      sha256: sha256File(patch.absoluteFile),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  const digest = sha256Text(JSON.stringify(sourceRows))
  if (marker.patchsetDigest !== digest) throw new Error('--skip-build patch set differs from the prebuilt marker')
  if (!existsSync(resolve(dshRoot, 'apps/cli/lib/bin.js'))) throw new Error('--skip-build: apps/cli/lib/bin.js is missing')
}
```

`parseApplyArguments` becomes a loop that accepts the flag:

```diff
-  for (let index = 1; index < argv.length; index += 2) {
-    const key = argv[index]
-    const value = argv[index + 1]
-    if (key !== '--dsh-root' || value === undefined) throw new Error('usage: ...')
-    dshRoot = resolve(value)
-  }
+  let skipBuild = false
+  for (let index = 1; index < argv.length; index += 1) {
+    const key = argv[index]
+    if (key === '--skip-build') { skipBuild = true; continue }
+    const value = argv[index + 1]
+    if (key !== '--dsh-root' || value === undefined) throw new Error('usage: ...')
+    dshRoot = resolve(value)
+    index += 1
+  }
   if (dshRoot === undefined) throw new Error('usage: ...')
-  return { dshRoot, profileDirectory: process.cwd() }
+  return { dshRoot, profileDirectory: process.cwd(), skipBuild }
```

`runApply` passes `skipBuild` to `applySelectedPatches`.

### 2. `apply-plus.sh`

Accept `--skip-build`, write the marker after a successful full apply, and pass the flag through:

```diff
-set -eux
+set -eux
+skip_build=0
+case "${1:-}" in
+  --skip-build) skip_build=1 ;;
+  "") ;;
+  *) echo "usage: apply-plus.sh [--skip-build]" >&2; exit 2 ;;
+esac
@@
-npm_config_registry="..." dsh-plus apply --dsh-root /opt/dsh-source
+apply_args=(apply --dsh-root /opt/dsh-source)
+[ "$skip_build" = "1" ] && apply_args+=(--skip-build)
+npm_config_registry="..." dsh-plus "${apply_args[@]}"
+
+if [ "$skip_build" = "0" ]; then
+  node /usr/local/lib/write-build-marker.mjs \
+    --source /opt/dsh-source \
+    --distribution /usr/local/lib/node_modules/@sparkelf/dsh-plus \
+    --profile /opt/dsh-home/profiles/dataops-web
+fi
```

`write-build-marker.mjs` reads `.dsh-plus/patchset.lock.json`, hashes each selected source patch
file as above, runs `git -C /opt/dsh-source rev-parse HEAD`, and writes
`{sourceRevision, patchsetDigest, builtAt}` atomically. Keeping the marker writer outside the
tarball means a Plus release does not need a second CLI change.

### 3. Docker layer split

```dockerfile
# stage 1: source tree, patches, official build, marker
FROM source-deps AS source-build
COPY ... (existing plus install inputs)
RUN bash /usr/local/bin/apply-plus.sh
# prune build-only paths here, while the same layer owns the deleted bytes

# stage 2: profile, pins, post-apply fixes, no official build
FROM source-build AS plus-build
RUN bash /usr/local/bin/apply-plus.sh --skip-build
```

A pin-only change still invalidates stage 1 because the Plus tarball is a `COPY` input. Reaching
the 5-minute target needs the patch packages extracted in an earlier stage keyed only by patch
bytes, with stage 1 copying that directory instead of the whole tarball. That extraction step is a
second change; measure it before claiming the target.

## Option B — restate the target

If the CLI change is not approved, the acceptance target must say: "`source-deps` hits; `apply`
still runs." That is the current behavior and `scripts/apply-plus-preflight.sh` reports it as
`full-build-required`. Do not claim a 5-minute pin-only rebuild in this state.

## Acceptance

```bash
cd images/workspace

# 1. Current candidate: expect full-build-required, 23 source patches, 26 bundles.
./scripts/apply-plus-preflight.sh --image dataops-ai-workspace-candidate:local --json /tmp/preflight.json

# 2. After the patch, rebuild the source stage and inspect the marker.
docker run --rm --entrypoint sh <candidate> -c 'cat /opt/dsh-source/.dataops-official-build.json'

# 3. Re-run apply with --skip-build in a disposable container; it must not invoke build:official.
docker run --rm --entrypoint sh <candidate> -c 'bash /usr/local/bin/apply-plus.sh --skip-build'
docker run --rm --entrypoint sh <candidate> -c 'grep -c "build:official" /tmp/apply.log || true'

# 4. Negative: change one patch file's bytes, then --skip-build must fail with a digest mismatch.
# 5. Default chain: build without the flag; the log must still contain the official build, and
#    verify-runtime-paths.sh must pass with 26 bundles.

# 6. Measure the pin-only path with a warm BuildKit cache; record stage time and `docker images`.
time docker build --network host -f context/Dockerfile.plus-cli-src \
  --build-arg BASE_IMAGE=<repo>:base-py312 ... context
```

A change is acceptable only when the default chain still builds from source, the negative marker
test fails closed, and a pin-only rebuild is measured at or below 5 minutes. Until then the target
stays unmeasured, as the gap record says.
