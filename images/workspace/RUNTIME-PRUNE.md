# Runtime prune analysis

Read-only analysis of `dataops-ai-workspace-candidate:local` (2026-11-26, image ID
`sha256:aec6ff25…b805c9`). No directory was deleted. `scripts/verify-runtime-paths.sh` is the
executable check; this page records why its whitelist has the paths it has.

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
profile's `.bin/dsh` resolves there. Package manifests expose a `source` export condition in 381
cases, but the image starts plain Node against built `lib/`, not `tsx` and not `--conditions=source`.

Three symlinks are already dangling in the working candidate and boot is unaffected:
`@deepseek-ai/dsh-benchmarks` (the build prunes `benchmarks/`), `.bin/dsh-im` (the IM connector is
removed from the default profile), and `.bin/dsoffice` (a shim the officecli installer does not
create). Their inertness is evidence that a missing target is tolerated only when no loaded module
imports it; it is not evidence that any other dangling link is safe.

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

**Blacklist — do not delete without a replacement mechanism:** every path above, plus any file
named by a `package.json` `bin`, `main`, `exports`, or `types` field reachable from a mounted
bundle. `pnpm deploy --prod` is the only supported way to reduce the dependency closure; it
produces a new tree with its own proof, rather than mutating this one.

**Delete candidates, after a disposable-container or candidate-image test:**

| Path | Measured | Evidence it is build-only |
| --- | --- | --- |
| `.git` | 54MB | `dsh-plus apply` reads it; no runtime module opens it |
| `snapshots/` | 23MB | test snapshots; no runtime reference outside test code |
| `scripts/` | 6.7MB | repository build and release scripts |
| `patches/` | 1.2MB | patch sources consumed by `apply` |
| `.github/` | 724KB | CI metadata |
| `python/` | 448KB | Python SDK source; the runtime starts Node |
| `tsconfig*.json`, `*.tsbuildinfo` | ≈5MB | build inputs and incremental-build state |
| `.gitlab-ci.yml`, `.oxlintrc.json` | 28KB | CI/lint metadata |
| `packages/**/src/` | 33MB | built `lib/` is what Node loads; must pass the import test below |
| `website/` | 248KB | linked but not mounted; deleting it adds a fourth known-inert dangling link |

Together these are about 124MB, roughly 5% of `/opt/dsh-source`. The gap record's 2–4GB runtime
target is not reachable by deleting build-only files: the source tree's own `node_modules` is
2.1GB and the two profile copies are 1.6GB. Reaching that target needs a production dependency
closure (`pnpm deploy --prod` / a pruned install) and a smaller base, as a separate change with its
own acceptance.

## Verification

```bash
cd images/workspace

# Baseline: every link resolves, versions and bundle count match, sizes are printed.
./scripts/verify-runtime-paths.sh \
  --image dataops-ai-workspace-candidate:local \
  --expect-dsh 0.2.3-alpha.2 \
  --expect-plus 0.2.9-alpha.106 \
  --expect-bundles 26

# Prove an import that exercises package lib/ and the profile's slot registry.
docker run --rm --entrypoint sh dataops-ai-workspace-candidate:local -c \
  '/opt/dsh-home/profiles/dataops-web/node_modules/.bin/dsh --version'

# After a prune candidate is built, run the full boot probe as well.
node acceptance/verify-workspace-image.mjs --image <candidate-tag>
```

A prune change is acceptable only when `verify-runtime-paths.sh` reports zero unexpected dangling
links, the bundle count is unchanged, and the boot probe still passes. Run the check before and
after; a size reduction without both records is not evidence.
