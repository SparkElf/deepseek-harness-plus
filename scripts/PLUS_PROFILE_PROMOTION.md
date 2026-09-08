# Plus Production Profile Promotion

This runbook is mandatory for a production Plus profile promotion. Package versions are not artifact identities: a Plus-applied package and a clean Core package can share the same version while carrying different runtime code.

## Invariants

- Treat the currently accepted production profile as the baseline.
- Build patched packages from the completed `dsh-plus apply` source tree, or preserve the baseline package byte-for-byte.
- Never replace a Plus-applied package with a clean-master build solely because their versions match.
- Every added, removed, or runtime-changed direct profile dependency or explicit `@deepseek-ai/*` source package must be declared in `packages/bundle/plus/production-profile-policy.json`; hoisted transitive links are installation layout, not profile ownership.
- A `preserve` entry must retain its runtime fingerprint. A `replace` entry names both exact fingerprints, `add` names the candidate, and `remove` names the baseline.
- Promotion and release publication stop on any undeclared change, fingerprint drift, missing capability marker, or missing profile bundle.

## Required Sequence

1. Materialize the candidate as a new immutable profile. Do not modify the active profile in place.
2. Review the complete closure diff:

   `pnpm run verify:plus-profile-upgrade -- --baseline BASELINE/profile --candidate CANDIDATE/profile --report`

3. Review every reported package. Update the policy only for intentional changes, including stable capability probes.
4. Run the blocking closure gate:

   `pnpm run verify:plus-profile-upgrade -- --baseline BASELINE/profile --candidate CANDIDATE/profile --policy packages/bundle/plus/production-profile-policy.json`

5. Run desktop acceptance at 1000px or wider and mobile acceptance at 418px, 390px, 360px, and 320px. Desktop screenshots are golden evidence, not optional context.
6. Verify Session Log placement, background job count/icon behavior, Composer row geometry, attachment rendering, Settings navigation, model-menu bounds, and browser errors.
7. Capture active Sessions, atomically switch the profile, restart through Supervisor, and recover only the captured Session ids.
8. Run the same closure gate against the active profile and repeat desktop/mobile browser acceptance on port 3080.
9. Publish the user-facing product Release only after active verification succeeds, following the asset policy below.

The verifier fingerprints runtime JavaScript, CSS, JSON, YAML, WebAssembly, and package manifests while ignoring source maps and declarations. This makes same-version payload drift a blocking production change.

## User-facing GitHub Release

- Use a `plus-vX.Y.Z` product tag. A `plus-npm-v*` tag may identify an npm sequence, but it must not create a user-facing GitHub Release.
- Start from an empty GitHub Release and upload exactly one manual asset: the Windows Desktop installer named `DeepSeek.Harness.Plus.Setup.<desktop-version>.exe`.
- GitHub owns the automatic `Source code (tar.gz)` and `Source code (zip)` links. Do not upload another source archive.
- Never upload npm package tarballs, profile closure files, screenshots, configuration files, block maps, checksums, evidence bundles, AppImage files, or Debian packages to the Plus product Release unless the user explicitly changes this policy for that release.
- Keep npm packages in the npm registry and CI package output in Actions artifacts. The Desktop installer embeds the reviewed Plus closure; exposing that closure as individual Release assets is not an installation requirement.
- Before publication, verify the Desktop installer against the exact Plus profile and official source revision, then run `Sync Desktop Installer`. The workflow rejects a non-empty target Release and rejects any local inventory other than one `.exe`.
- Release notes state the product version, Desktop version, Plus profile version, official source revision, installation prerequisites, signing status, and the installer SHA-256. Internal profile paths, CI screenshots, and package-by-package inventories do not belong in the user-facing notes.

## Rebuild And Restart Enforcement

- Every Core change needed by Plus must be owned by a source patch relative to `dshPlus.sourceBase.revision`; a later Core commit alone is not a production artifact.
- `dsh-plus apply` must make official source workspaces override same-version CLI packages in the materialized profile.
- Build the patched source after apply and verify that every patched workspace package resolves from the source checkout, not the CLI dependency tree.
- Bump a patch or distribution package version whenever its payload changes. Do not republish or repackage a different payload under an existing version.
- After the production closure gate passes, run `dsh-plus-profile-guard accept` and only then switch the profile.
- Install the guard at `$DSH_HOME/supervisor/profile-guard.mjs`; systemd must run it through `ExecStartPre` before importing Supervisor code from `$DSH_HOME/profiles/plus`.
- An automatic updater may materialize a candidate, but it cannot become the accepted startup profile without a new closure gate and explicit acceptance.
