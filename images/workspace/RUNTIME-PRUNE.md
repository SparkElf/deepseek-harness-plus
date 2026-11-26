# Runtime prune

Status: implemented (G7, 2026-11-26) as an optional final phase. The default build does not prune.
`RUNTIME_PRUNE=1` enables it; the candidate image is the only intended consumer.

`context/runtime-prune.sh` executes the delete list below against `/opt/dsh-source` and asserts the
runtime whitelist before and after. `context/apply-plus.sh` calls it at the end of the `source`
phase (and of a `full` run), in the same Docker layer that created the build output. Running it in
the `profile` stage instead would only hide lower-layer files behind whiteouts, so the image size
would not shrink. The profile stage then reads the pruned tree: `.git` is gone and
`dsh-plus apply --skip-build` authenticates the prebuilt source from the build marker.

## What the runtime actually resolves

The profile is not self-contained. `/opt/dsh-home/profiles/dataops-web/node_modules` contains 461
symlinks; their targets are:

| Target root | Links | Why it is resolved at runtime |
| --- | --- | --- |
| `/opt/dsh-source/packages` | 397 | Every mounted `@deepseek-ai/dsh-*` bundle imports its built `lib/` |
| `/opt/dsh-source/vendor` | 9 | Cordis loader and its plugins |
| `/opt/dsh-source/native` | 6 | Native `.node` binaries |
| `/opt/dsh-source/apps` | 6 | `dsh` itself resolves to `/opt/dsh-source/apps/cli/lib/bin.js` |
| `/opt/dsh-source/website` | 1 | `@deepseek-ai/website`, a private workspace package linked by `dsh-root` |
| `..` (inside the profile) | 39 | Profile-local links |
| unresolved (`benchmarks`, `officecli`, empty) | 3 | Already dangling and inert; see below |

The measured tree, after the build's existing `*.map`/`tests`/`docs`/`benchmarks` cleanup:

| Path | Size | Runtime role |
| --- | --- | --- |
| `/opt/dsh-source` | 2.4GB | source tree, symlink target root |
| `/opt/dsh-source/node_modules` | 2.1GB | dependency resolution for every linked package |
| `/opt/dsh-source/packages` | 241MB | 397 package directories (`lib/`, `locale/`, `package.json`) |
| `/opt/dsh-home/profiles/dataops-web` | 805MB | live profile and its own `node_modules` |
| `/opt/dataops-dsh-profile-template` | 805MB | first-boot seed, copied to a new volume |

`packages/**/src` totals 33MB and `packages/**/lib` 137MB. The CLI entry is `lib/bin.js`; the
profile's `.bin/dsh` resolves there. The image starts plain Node against built `lib/`, not `tsx`
and not `--conditions=source`, so `src` is a build input rather than a runtime target.

Three symlinks are already dangling in the working candidate and boot is unaffected:
`@deepseek-ai/dsh-benchmarks` (the build prunes `benchmarks/`), `.bin/dsh-im` (the IM connector is
removed from the default profile), and `.bin/dsoffice` (a shim the officecli installer does not
create). A prune adds `@deepseek-ai/website` as a fourth known-inert dangling link;
`verify-runtime-paths.sh --expect-pruned` accepts it only while the prune stamp exists.

## Prune contract

**Whitelist — never delete, and assert after every prune candidate:**

1. `/opt/dsh-source/apps/cli/lib/` and `package.json` — the `dsh` entry point.
2. `/opt/dsh-source/packages/*/*/lib/`, `package.json`, `locale/`, and `node_modules/` — the 397
   linked packages and their dependency links.
3. `/opt/dsh-source/vendor/` — nine Cordis links.
4. `/opt/dsh-source/native/` — six native links.
5. `/opt/dsh-source/node_modules/` — including `.pnpm`; linked packages resolve their imports
   through it. A file-level delete here breaks resolution long before the image shrinks.
6. `/opt/dsh-home/profiles/dataops-web/` and `/opt/dataops-dsh-profile-template/` — live profile
   and first-boot seed. The template is a full copy; deduplicating it needs hardlinks or a
   first-boot copy, not deletion.
7. `/opt/dsh-plus` — symlink to the live profile.

The script counts package manifests and `lib`/`locale`/`node_modules` directories before and after,
and fails before deleting anything if the counts would change. It never traverses
`node_modules` when deleting `*.tsbuildinfo` or `packages/**/src`.

**Blacklist — do not delete without a replacement mechanism:** every path above, plus any file
named by a `package.json` `bin`, `main`, `exports`, or `types` field reachable from a mounted
bundle. `pnpm deploy --prod` is the only supported way to reduce the dependency closure; it
produces a new tree with its own proof, rather than mutating this one.

**Delete candidates, measured on `dataops-ai-workspace-candidate:local` (2026-11-26):**

| Path | Measured | Evidence it is build-only |
| --- | --- | --- |
| `.git` | 53.2MB | a full `dsh-plus apply` reads it; a `--skip-build` run uses the marker instead |
| `snapshots/` | 16.8MB | test snapshots; no runtime reference outside test code |
| `scripts/` | 5.6MB | repository build and release scripts |
| `patches/` | 1.1MB | patch sources consumed by `apply` |
| `.github/` | 578KB | CI metadata |
| `python/` | 363KB | Python SDK source; the runtime starts Node |
| `website/` | 158KB | linked but not mounted; deleting it adds a fourth known-inert dangling link |
| `tsconfig*.json` | 101KB | build inputs |
| `*.tsbuildinfo` (excluding `node_modules`) | 43.9MB | incremental-build state |
| `packages/**/src/` | 33.1MB | built `lib/` is what Node loads; must pass the import test below |
| `.gitlab-ci.yml`, `.oxlintrc.json` | 21KB | CI/lint metadata |

The dry run totals **154.9MB**, about 6% of `/opt/dsh-source`. The gap record's 2–4GB runtime
target is not reachable by deleting build-only files: the source tree's own `node_modules` is
2.1GB and the two profile copies are 1.6GB. Reaching that target needs a production dependency
closure (`pnpm deploy --prod` / a pruned install) and a smaller base, as a separate change with its
own acceptance.

Because `.git` is deleted, a pruned image cannot run a full `dsh-plus apply` in place. A
`--skip-build` profile phase still works: it authenticates the prebuilt tree from
`.dataops-official-build.json` and leaves the official build output untouched. That is why the
prune ends the source phase and why the profile stage never enables it.

## Verification

```bash
cd images/workspace

# Dry run: list and size every candidate without deleting anything.
docker run --rm --entrypoint bash <image> -c \
  'bash /usr/local/bin/runtime-prune.sh --root /opt/dsh-source --dry-run'

# Baseline: every link resolves, versions and bundle count match, sizes are printed.
./scripts/verify-runtime-paths.sh \
  --image <candidate> \
  --expect-dsh 0.2.3-alpha.2 \
  --expect-plus 0.2.9-alpha.106 \
  --expect-bundles 26

# Pruned candidate: require the stamp, the removed candidate set, and the known-inert website link.
./scripts/verify-runtime-paths.sh \
  --image <pruned-candidate> \
  --expect-dsh 0.2.3-alpha.2 \
  --expect-plus 0.2.9-alpha.106 \
  --expect-bundles 26 \
  --expect-pruned

# Prove an import that exercises package lib/ and the profile's slot registry.
docker run --rm --entrypoint sh <pruned-candidate> -c \
  '/opt/dsh-home/profiles/dataops-web/node_modules/.bin/dsh --version'

# Full boot probe.
node acceptance/verify-workspace-image.mjs --image <pruned-candidate>
```

A prune change is acceptable only when `verify-runtime-paths.sh --expect-pruned` reports zero
unexpected dangling links, the bundle count is unchanged, and the boot probe still passes. Run the
check before and after; a size reduction without both records is not evidence.