# Profile-stage speedup analysis

Status: analysis only (B-03d, 2026-11-27). No build input, script, Dockerfile or source file was
changed, and nothing is committed. Evidence is one staged build (`/tmp/b03b-final-staged.log`,
3,682 lines), the two images that build produced, and the code paths named below.

## TL;DR

- The 790 s reported as "profile" is the wall time of the whole `--target plus-build` docker build,
  not the profile phase. The `apply-plus.sh --phase profile` step inside it took **6.8 s**, of which
  4.1 s is a `pnpm install` that found a valid lockfile and a warm store.
- **52.7 % of the 790 s (416.3 s) is the source phase running a second time** inside the plus build.
  `scripts/build-plus-staged.sh` forwards `RUNTIME_PRUNE` to the source build but not to the plus
  build, so the parent stage's cache key differs (`RUNTIME_PRUNE="1"` vs `"0"`) and `source-build`
  re-executes.
- Another 100.9 s is the `source-deps` stage re-executing in the plus build (only its `FROM` was
  cached), and 181.4 s is exporting and unpacking a ~6.7 GB layer diff.
- A pin-only change cannot avoid a full source rebuild today: the Plus tarball is a `COPY` input of
  `plus-inputs`, which is the parent of `source-build`, and the source phase is a single `RUN` that
  owns the profile install, the source install and `build:official`.
- 5 min for a pin-only rebuild is realistic, but only by building the profile layer `FROM` an
  already-published source image. That path needs no change to `apply.ts` and measures out at
  roughly 130-160 s. Today's floor is ~680 s.

## 1. Where the 790 s goes

`docker build --target plus-build` (segment 2 of the log) breaks down as follows. Step times are
BuildKit's per-step `DONE n.ns`; the stage sums plus overhead reproduce the 790 s.

| Part | Steps | Seconds | Share |
| --- | --- | ---: | ---: |
| `source-deps` stage, re-executed | 9 RUN steps (pnpm install 78.6 s, apt 7.7 s, unpack 5.2 s) | 100.9 | 12.8 % |
| `plus-inputs` stage, re-executed | 20 steps (`npm install -g` of the repacked tarball 36.9 s) | 43.1 | 5.5 % |
| `source-build` RUN, re-executed | patches + profile install + source install + `build:official` | 416.3 | 52.7 % |
| `plus-build` stage | 38 steps, of which `--phase profile` is 6.8 s | 43.9 | 5.6 % |
| export + unpack | one ~6.7 GB layer diff | 181.4 | 23.0 % |
| docker overhead | context transfer 0.7 s, step setup | ~4 | 0.5 % |

For comparison, the same stages in the source-target build (segment 1, `RUNTIME_PRUNE=1`, 831 s):
`source-deps` 175.7 s, `plus-inputs` 40.6 s, `source-build` 448.4 s, export 162.6 s.

### 1.1 The profile phase is not the expensive part

The plus build's first step is the whole profile half:

```text
#38 [plus-build  1/38] ... bash /usr/local/bin/apply-plus.sh --phase profile
#38 2.058 Lockfile is up to date, resolution step is skipped
#38 2.672 Packages: +13 -76
#38 5.602 Done in 4.1s using pnpm v11.28.5
#38 5.698 [dsh-plus] skip-build verified /opt/dsh-source/.dataops-official-build.json
#38 6.502 [dsh-plus] applied 23 patches; lock .../patchset.lock.json
#38 6.741 apply-plus phase=profile skip_build=1 seconds=5
#38 DONE 6.8s
```

The reason it is cheap: the source phase already installed the profile in the layer below, so this
install is a delta (`+13 -76`) against an existing `node_modules`.

### 1.2 The 416.3 s is the source phase, not the profile phase

Inside `apply-plus.sh --phase source` in the plus build (log step `#37`, 416.3 s):

| Sub-phase | Seconds | Evidence |
| --- | ---: | --- |
| `prepare_profile_workspace` | 0.5 | `#37 0.577` |
| profile install #1 (`apply.ts` `prepareSelection`) | 69.5 | `Done in 1m 9.5s`, 1067 packages, `downloaded 0` |
| patch materialization + profile install #2 | 24.6 | `Done in 24.6s`, 193 added |
| source `pnpm install` after patches | 16.9 | `Done in 16.9s`, 1770 resolved, 1 added |
| `pnpm run build:official` | 281.3 | `#37 126.4` → `#37 407.7` |
| marker, lock, `restore_edition_bundles`, `flatten_slots`, `cleanup_build_only` | 23.5 | `407.7` → `416.3` |

Both profile installs are link-bound, not network-bound: the store cache mount is warm and every
install reports `downloaded 0`. The 69.5 s is 11 s of resolution plus ~59 s of materializing 1067
packages from the content-addressable store into `node_modules` (pnpm prints `Packages are copied
from the content-addressable store to the virtual store`). The store is a BuildKit cache mount and
`node_modules` is in the layer, so they are different filesystems and pnpm cannot hardlink across
them.

Why the plus build re-ran the source phase at all: `scripts/build-plus-staged.sh:54-62` passes
`--build-arg "RUNTIME_PRUNE=$runtime_prune"` to the `source-build` target but not to the
`plus-build` target. The step embeds the value in its command (`RUNTIME_PRUNE="${RUNTIME_PRUNE}"`,
`context/Dockerfile.plus-cli-src:248-253`), so `1` versus the default `0` is a different cache key
and the step re-executes. The log names the value in the step header (`RUNTIME_PRUNE="1"` for
`#35`, `RUNTIME_PRUNE="0"` for `#37`), and the second run says so itself at line 3027:
`runtime prune disabled (RUNTIME_PRUNE != 1)`. `docker-bake.hcl` has the same gap: the
`source-build` target passes `RUNTIME_PRUNE` (line 118), the `plus` target does not (lines
140-148).

The `source-deps` re-execution has no such explanation in the Dockerfile text: its steps do not
reference `RUNTIME_PRUNE`, and the only build-argument difference between the two invocations is
that one. It is recorded here as measured (100.9 s, only `#5 CACHED`); the first rebuild after the
argument is made uniform will show whether it disappears or needs its own investigation.

## 2. Why a pin-only change still pays a full source build and a cold profile install

A pin change edits `dshPlus.profile.dependencies` inside `sparkelf-dsh-plus-<version>.tgz`. It does
not change patch bytes, the DSH source revision, or any file under `/opt/dsh-source`. Four separate
mechanisms turn it into a full rebuild anyway.

1. **The layer graph puts the tarball above the source build.** `plus-inputs` (`COPY` of the
   tarball, `npm install -g`, profile-dependency rewrite) is `FROM source-deps`, and `source-build`
   is `FROM plus-inputs` (`Dockerfile.plus-cli-src:113`, `:246`, `:254`). A byte change in the
   tarball therefore invalidates `plus-inputs` and every stage below it, including the layer that
   contains the built `/opt/dsh-source`.
2. **The source phase is one opaque `RUN`.** `apply-plus.sh --phase source` (`apply-plus.sh:377-394`)
   performs the profile install, the source install, `build:official`, the marker and the repairs in
   a single Docker layer. Any invalidation redoes all of it; there is no layer boundary that could
   keep the 281 s build while redoing a 70 s install.
3. **The profile install is never incremental across builds.** The only `node_modules` a pin build
   can start from is whatever the parent layer carries, and that parent is the profile shipped by
   the base image, which does not hold the Plus dependency set. `apply.ts:502` runs
   `pnpm install --no-frozen-lockfile` unconditionally, so a fresh layer always materializes all
   1067 packages. Measured contrast: 69.5 s cold versus 4.1 s when the profile is already installed
   (`+13 -76`).
4. **A full apply installs the profile twice.** `prepareSelection` installs at `apply.ts:502`;
   `writeProfileComposition` then rewrites the profile manifest, and `applySelectedPatches`
   installs again at `apply.ts:926` because `profileChanged` is true. 15-25 s of the 94 s is the
   second install of 193 packages.

`--skip-build` already implements the right contract — it authenticates the marker and refuses to
touch the source tree (`apply.ts:913-947`, `apply-plus.sh:174-182`). It cannot help today because
the stage that owns the marker is rebuilt before the plus stage starts. In other words: the CLI
already supports a pin-only rebuild; the image graph does not expose it.

## 3. Levers

| # | Lever | Change | Saves (basis) | Effort |
| --- | --- | --- | --- | --- |
| 1 | Forward `RUNTIME_PRUNE` to the plus build | `build-plus-staged.sh:58` + `docker-bake.hcl` `plus.args` | 416 s whenever the source inputs are unchanged; removes the false 790 s "profile" number | 10 min |
| 2 | Build the profile layer `FROM` a published source image | new `Dockerfile.plus-profile-only` + `scripts/build-plus-profile-only.sh` | 416 s + the 69.5 s cold install on every pin-only build | 0.5-1 d |
| 3 | Cache mount for the global Plus install | add `--mount=type=cache,target=/root/.npm` to `Dockerfile.plus-cli-src` step 14/20 | ~30 s of the 36.9 s `npm install -g` per plus-inputs run | 10 min |
| 4 | Install the profile once | compute composition before install #1, drop the second `runPnpm` | 15-25 s per full apply | 0.5 d |
| 5 | Ship and use a profile lockfile | write `pnpm-lock.yaml` into the tarball, `--frozen-lockfile --prefer-offline` | ~9 s resolution per install, and pins stop drifting | 0.5 d |
| 6 | Separate patch payload from pin metadata | content-addressed `plus-patches-<digest>.tgz` as the source stage's input | same 416 s as lever 2, but keeps a single Dockerfile | 1-2 d |
| 7 | Shrink the exported diff | falls out of 2 and 6 | 181 s → ~20-40 s | — |

Notes on the ones that are easy to misread:

- **`pnpm install --offline` buys nothing here.** Every install in the log reports `downloaded 0`;
  the store is warm. `--prefer-offline` and `--frozen-lockfile` are still worth having for
  determinism and to skip resolution, but the 59 s is materialization, not network.
- **"Only re-link changed packages" is already what pnpm does** when `node_modules` survives — the
  4.1 s profile-phase install is exactly that. The lever is preserving `node_modules` across builds,
  not a smarter linker. `linkOfficialPackages` (`apply.ts:1035-1037`) does delete and recreate the
  whole `node_modules/@deepseek-ai` scope (~500 symlinks) on every apply; it is unconditional but
  only costs 1-3 s, so leave it.
- **Docker cache mounts for `node_modules` are the wrong tool.** A cache mount is not image content;
  the profile must be in the layer the runtime reads. Mounting the profile directory would make the
  install incremental and then require copying the result into the layer anyway, which reintroduces
  the same write cost.

Lever 2 in more detail, because it is the one that reaches the 5 min target without touching
`apply.ts`:

```text
Dockerfile.plus-profile-only
  FROM ${SOURCE_IMAGE}                        # previously built --target source-build, marker intact
  COPY sparkelf-dsh-plus-${DSH_PLUS_VERSION}.tgz /tmp/sparkelf-dsh-plus.tgz
  # the pin-edit / anysearch / im / repack / npm install -g / rewrite-profile-deps steps,
  # copied from plus-inputs 7/20 .. 17/20 and unchanged
  RUN ... apply-plus.sh --phase profile       # delta install against the warm profile, link, repairs
  # plus-build 2/38 .. 38/38, unchanged
```

Its precondition is already implemented: `scripts/apply-plus-preflight.sh` reports
`skip-build-safe` only when the new tarball's selected patch files hash to the marker's
`patchsetDigest` and the source revision matches. When it reports `full-build-required`, the build
falls back to the current two-stage chain. That is the same gate `--skip-build` uses
(`APPLY-SPLIT.md:37-55`).

## 4. Is the 5 min target realistic?

Yes for a pin-only change, no for anything that changes patch bytes. Today's numbers:

| Tier | Trigger | Measured today | Realistic target | Verdict |
| --- | --- | ---: | ---: | --- |
| T0 cold | base image or first build on a host | 1621 s | no target | — |
| T1 rebuild, inputs unchanged | nothing changed | 790 s (plus stage) | 10-190 s | after lever 1 |
| T2 pin-only | one `dshPlus.profile.dependencies` pin | 682-790 s | 130-160 s | after lever 2 (+3) |
| T3 patch or source change | patch bytes or `DSH_SOURCE_REVISION` | 700-800 s | 650-700 s | build + export bound; not a 5 min target |

T2 arithmetic, from measured parts: `plus-inputs` without `source-deps` 43.1 s (≈13 s with lever 3)
+ `--phase profile` on a warm profile 6.8 s base, 15-40 s for a changed pin + plus tail 43.9 s +
export of a small diff 20-40 s ≈ 130-160 s.

T2 and T3 cost the same today because both invalidate the same `source-build` stage; the tiers only
separate after lever 2. T3 then stays expensive because `build:official` (281-289 s), the two
installs (86-95 s), the plus tail (44 s) and a 5.5 GB export (181 s) are irreducible without caching
the build itself.

The tier that is *not* worth optimizing is T0: `source-deps` (175.7 s) and `build:official`
(~285 s) dominate and are real work.

## 5. Commands

Nothing below was executed for this report.

**A. Prove the 416 s is a cache-key artifact (after lever 1).**

```bash
cd images/workspace
RUNTIME_PRUNE=1 ./scripts/build-plus-staged.sh 0.2.9-alpha.106 2>&1 | tee /tmp/b03d-after-argfix.log
grep -E '^#[0-9]+ \[source-build 1/1\]|^#[0-9]+ CACHED' /tmp/b03d-after-argfix.log
```

Expected: `[source-build 1/1]` reports `CACHED` in the plus invocation and `plus-build` drops from
790 s to roughly 60-190 s (10 s if the `source-deps` miss also disappears, ~190 s if it does not).

**B. Measure the profile phase on the prebuilt source image (no rebuild, no source install).**

```bash
docker run --rm --entrypoint bash \
  dataops-ai-workspace-test:source-build-0.2.9-alpha.106 \
  -c 'time bash /usr/local/bin/apply-plus.sh --phase profile'
```

Expected: `apply-plus phase=profile skip_build=1 seconds=5-8`, matching log step `#38`.

**C. Measure the incremental-install floor on a finished profile.**

```bash
docker run --rm --entrypoint bash \
  dataops-ai-workspace-test:plus-cli-py312-0.2.9-alpha.106 \
  -c 'cd /opt/dsh-home/profiles/dataops-web && time pnpm install --frozen-lockfile --prefer-offline'
```

Expected: 2-6 s when nothing changed, versus 69.5 s for the cold install. This is the number that
justifies lever 2.

**D. Pin-only acceptance (after lever 2).**

```bash
cd images/workspace
# 1. the current source image is still valid for the new tarball
./scripts/apply-plus-preflight.sh \
  --image dataops-ai-workspace-test:source-build-0.2.9-alpha.106 \
  --json /tmp/preflight-pin.json          # must print skip-build-safe
# 2. build only the profile layer
SOURCE_IMAGE=dataops-ai-workspace-test:source-build-0.2.9-alpha.106 \
  ./scripts/build-plus-profile-only.sh 0.2.9-alpha.107
# 3. the log must not contain "--phase source"
```

Expected: ≤ 180 s wall, no `apply-plus.sh --phase source` line, and the same bundle count from
`verify-runtime-paths.sh` as the full chain.

**E. Pin-only regression guard.** Bump one pin (for example `@anysearch/anysearch-dsh` 0.1.8 →
0.1.9), run D, and confirm the image diff is limited to the profile's `node_modules` delta — not a
5.5 GB `/opt/dsh-source` rewrite.

## 6. Open questions and risks

- The `source-deps` cache miss in the second invocation is unexplained; measure it before
  attributing the 100.9 s to lever 1.
- Lever 2 assumes a source image can be reused across Plus versions. The patch-set digest is the
  only safe gate; `apply-plus-preflight.sh` already implements it, and a build that skips the gate
  would ship a source tree whose `lib/` does not match the tarball's patches.
- A profile-only Dockerfile duplicates the tail of `plus-build` (steps 2/38-38/38). Either accept
  the duplication with a comment naming its source, or extract the tail into a shared include; the
  first is smaller and keeps the existing entry untouched.
- The 59 s package materialization may also be inflated by the store being a cache mount on a
  different filesystem from `node_modules` (pnpm prints "copied", not "hardlinked"). Checking
  `stat -c %d` on the store and on `node_modules` inside a build container would settle whether a
  same-filesystem store is worth trying; it does not affect any lever above.

## Appendix: measured stage table

Segment 2 (`--target plus-build`, 790 s), steps ≥ 1 s:

| Step | Stage | Seconds |
| --- | --- | ---: |
| `#6` apt-get | source-deps | 7.7 |
| `#9` npm -g pnpm | source-deps | 3.0 |
| `#11` unpack source | source-deps | 5.2 |
| `#13` node-gyp headers | source-deps | 4.5 |
| `#16` `pnpm install --frozen-lockfile` (source) | source-deps | 78.6 |
| `#30` repack + `npm install -g` Plus | plus-inputs | 36.9 |
| `#37` `apply-plus.sh --phase source` | source-build | 416.3 |
| `#38` `apply-plus.sh --phase profile` | plus-build | 6.8 |
| `#39` exa pack | plus-build | 3.0 |
| `#44` `cp -a` profile to template | plus-build | 10.4 |
| `#54` apt-get fonts | plus-build | 8.0 |
| `#55` relabel fonts | plus-build | 9.7 |
| `#62` sidecar npm install | plus-build | 3.2 |
| `#76` export + unpack | — | 181.4 |

Image sizes for the export cost: base 4.85 GB, `source-build` 10.4 GB, `plus-cli` 11.6 GB. The
source layer diff (~5.5 GB) is what a pin-only rebuild re-exports today.