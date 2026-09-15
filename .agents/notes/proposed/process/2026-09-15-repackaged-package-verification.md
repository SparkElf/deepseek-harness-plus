# Agent Note: A repackaged workspace is verified against its source, not against a list

Status: proposed

English | [中文](2026-09-15-repackaged-package-verification.zh.md)

## Problem

The Plus distribution republishes twenty official workspaces under our scope, because a patch against official source cannot reach a registry installation. Four defects reached published packages between the first release of that mechanism and the fourth, and every one of them passed the checks in place at the time.

| Defect | How it looked at review time | What a consumer saw |
|---|---|---|
| `dist` missing from the payload list | every manifest correct | the server answered 404 for every page |
| `cordis.patch.yml` missing | every manifest correct | a bundle installed and mounted nothing |
| the `dsh` field stripped | every manifest correct | twenty packages loaded nothing; the model selector never appeared |
| our version written into dependency ranges | the name resolved | install failed on a release that does not exist |

The checks that existed compared a package against a list its author had written. A list cannot report what its author did not think of, so every defect was found the same way: by installing the result and looking at it.

## Proposal

**A repackaging run verifies each package against the workspace it came from, and the verification runs inside the publish command.** Three scripts form one command.

1. `package-patched-official.mjs` copies a workspace's published payload and rewrites its identity onto our scope.
2. `verify-patched-official.mjs` compares the output with the source, failing when a package omits a payload its workspace publishes, drops a manifest field its workspace declares, or names a version the official registry does not serve.
3. `publish-patched-official.mjs` publishes in dependency order.

```sh
node scripts/release/republish-patched-official.mjs --source <built-checkout> [--version <semver>] [--dry-run]
```

The version derives from the checkout. A hardcoded constant drifted on every run and turned a release step into an edit.

## Findings this change rests on

1. **`dsh` is a package's own declaration, not build metadata.** `dsh.client` registers a browser module, so a package carrying it is loaded by the web app and one without it is installed and ignored. Stripping it produced twenty packages that passed every manifest check and loaded nothing.
2. **`cordis.patch.yml` is a bundle's composition.** A bundle's `package.json` lists it in `files`, and without it the bundle mounts nothing.
3. **A package's `files` list is the authority on what it publishes.** Comparing the packaged output with the roots that list names catches an omission the manifest cannot show, because a package's own `files` list still promises the missing directory.
4. **A republished package keeps the official dependency names and ranges.** Built code imports the official specifiers, and the official registry serves the ranges; writing our version into a range names a release that does not exist. A run republishing under the upstream version has the correct range, so the check applies only to a correction released under our own version.
5. **npm reads `overrides` only from a project's own root.** A globally installed profile is not one, so an override there is silently ignored; the profile installing its own tree is what makes it that root.

## Acceptance criteria

- Removing an entry from the payload list fails the spec.
- Removing `dsh` from the stripped fields fails the spec.
- Removing `cordis.patch.yml` from the payload list fails the pipeline at the verifier.
- The publish command runs packaging, verification, and publication, with no path that reaches publication while skipping verification.

## Alternatives considered

- **A checklist of things to copy.** Rejected: it is what failed four times. The list is written by the same author who missed the omission, and nothing executes it.
- **Compare against the official npm tarball instead of the checkout.** Rejected: the checkout is the build the release already produced, so comparing against it needs no network and no second source of truth.
- **Verify after publishing.** Rejected: a published version cannot be withdrawn, and the registry serves no second package under the same name.

## Risks

- **The verifier trusts each workspace's `files` list.** A workspace that under-declares its own payload is not caught; the check detects a repackaging omission and not an upstream packaging defect.
- **Version-pinned build decisions go stale on an upstream bump.** `allowBuilds` names exact versions and `verify-plus-governance` pins the table, so an upstream bump fails a gate rather than silently skipping a build.

## Consequences

- **A repackaging run is one command.** The release step is no longer a sequence a person performs from memory.
- **A new payload kind is a reviewed change.** Adding or removing an entry changes what every package carries, and the spec states which entries exist.
