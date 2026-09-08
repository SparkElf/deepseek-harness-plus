# Agent Note: User-facing Plus Release assets

Status: implemented

English | [中文](2026-09-07-user-facing-plus-release-assets.zh.md)

## Problem

The Plus GitHub Release had become a projection of internal publication work. npm tarballs, profile closure archives, screenshots, configuration files, checksums, and platform installers appeared together in one asset list. Those files are useful to package publishers and reviewers, but an ordinary user needs one obvious installer. GitHub already provides source archives for every release tag, so uploading package and evidence archives made the product Release harder to use without adding an installation path.

The Desktop installer embeds the reviewed Plus closure. Publishing each closure tarball beside the installer is therefore not required for installation or repair.

## Decision

A user-facing Plus release uses a `plus-vX.Y.Z` product tag and starts with no manual assets. The only manually uploaded asset is one Windows Desktop installer named `DeepSeek.Harness.Plus.Setup.<desktop-version>.exe`. GitHub's automatic `Source code (tar.gz)` and `Source code (zip)` links are the source distributions and are not duplicated.

npm package tarballs remain in the npm registry, and CI package output remains in Actions artifacts. A `plus-npm-v*` tag may identify an npm publication sequence, but it does not create a user-facing GitHub Release. Screenshots, configuration files, block maps, checksums, evidence bundles, AppImage files, and Debian packages are excluded unless the user explicitly changes the release policy for one release.

The `Sync Desktop Installer` workflow downloads only `*.exe`, requires exactly one downloaded file, refuses a target Release that already has a manual asset, uploads without `--clobber`, and verifies that the published inventory contains exactly one installer with the expected name. `scripts/ci-workflow.spec.ts` pins those checks so a later workflow edit cannot silently restore the mixed asset list.

The release notes contain product and component versions, the official source revision, prerequisites, signing status, and the installer SHA-256. They exclude internal profile paths, test screenshots, and package-by-package inventories.

## Alternatives considered

**Expose the complete closure for transparency.** Rejected because npm and Actions already retain those files, while the Desktop installer carries the installation closure. Repeating them in the product Release hides the supported entry point.

**Publish Windows, AppImage, and Debian installers by default.** Rejected for the current policy because the user requested one Desktop installer. A future release may add platforms only through an explicit policy change before publication.

**Keep one mixed Release and explain each asset in the notes.** Rejected because documentation does not remove ambiguity from the download list. The asset boundary must be mechanically enforced.

## Consequences

The Plus product Release presents one primary action and GitHub's automatic source archives. Internal npm and verification publication remain available in their owning systems without appearing as product downloads.

A target Release with any existing manual asset cannot be updated by the sync workflow. Release correction creates a new product tag and empty Release instead of accumulating or replacing unrelated files. Adding another platform requires a reviewed policy and test change.
