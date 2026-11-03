# Agent Note: The DataOps variant declares its full plugin set

Status: implemented

English | [中文](2026-10-30-dataops-variant-plugin-set.zh.md)

## Problem

A DataOps workspace image shipped fewer plugins than the profile it replaced. The base upgrade changed the runtime line, the image was assembled from the Plus profile, and capabilities the deployment exists for — knowledge base, credential manager, group chat, citation, task bus, the DataOps connector's own query-result analysis — were simply absent while the build and the boot both reported success.

Two declarations disagreed, and neither was complete. The variant `dshPlus.profile.standaloneVariants.dataops` named only two added packages. Most of the DataOps plugins were never in a durable declaration at all: they were tarballs handed to `--extra-plugins` from the build host, so an image built without that directory lost them silently. The image verifier's `REQUIRED` list named two packages as well, so it agreed with neither the old profile nor the deployment's real needs.

## Decision

The variant is the durable declaration of every plugin the deployment can install from the registry. Its `includePackages` gains knowledge base, credential manager, group chat, citation, and task bus at their reviewed versions (the connector and query-result analysis were already there), and `includeBundles` mounts the same set. `@sparkelf/dsh-dataops-managed` moves to 0.3.21. The generated `packages/standalone/dataops-standalone/package.json` is refreshed from the variant, which also picks up a dependency the manifest had drifted from.

Two packages cannot join the registry set: `@sparkelf/dsh-dataops-account` and `@sparkelf/dsh-ocr` are private builds that publish nothing. They stay on the `--extra-plugins` path, and a checked-in declaration names them with their exact versions. That declaration is the single source both build halves read: the profile assembler fails when a required plugin is not installed, not mounted, or at another version, and the image verifier reads the same file from the image to check the installed tree and the bundle rows. A build that loses one now stops instead of shipping.

`dsh-video-preview` leaves the variant. Its 0.1.4 build needs a runtime service the 0.2.2 base no longer provides, so the variant records the omission rather than mounting a package that cannot activate; the image verifier asserts its absence the same way it asserts the retired admin package's. `@sparkelf/dsh-dataops-admin` stays retired and stays out of both lists.

The old profile's `@sparkelf/dsh-better-sidebar@0.28.0-sparkelf.grid.17` is not carried. Its peer range pins the 0.2.1 line and `@huanlin/dsh-plugin-better-locale`, which the image no longer installs, so mounting it would defer the sidebar instead of restoring it. The variant keeps the reviewed unscoped `dsh-better-sidebar@0.28.0`.

## Alternatives considered

**Move the private plugins into `includePackages`.** Rejected because neither package is published and one is `private: true`; a registry spec would fail the install instead of installing nothing.

**Keep the full list only in the image verifier.** Rejected because the verifier runs after the image exists: it reports the loss but cannot prevent a build that never had the tarballs, and it duplicates the variant at a third site.

**Declare the extra plugins as `file:` specs in the standalone manifest.** Rejected because the manifest is a published registry artifact: a build-host path does not exist for anyone installing it.

**Mount the scoped sidebar fork to match the old profile exactly.** Rejected because its peers pin the previous runtime line and a locale plugin the image removed; the capability would stay dormant while its package and row passed every structural check.

## Testing

`pnpm run verify:standalone-variants` regenerates the manifest from the distribution and compares it; it failed as stale before this change and passes after. `pnpm run verify:standalone-manifest` keeps the unreduced Plus manifest unchanged. The generator's peer-override suite covers the version resolution the new pins use.

The required-plugin declaration is tested directly in the DataOps repository: `node --test infra/docker-workspace/dataops-required-plugins.test.mjs` covers a complete profile, a registry plugin the variant stopped declaring, a package installed without a bundle row, a missing private tarball, a private tarball at another version, and the declaration file's own validation.

## Related decisions

The distribution owns the reviewed set and the variant reduces it; that ownership and the patch-range reasoning remain with [ranged Plus patchset distribution](2026-08-29-ranged-plus-patchset-distribution.md). The DataOps connector's own plugin behaviour — effective capabilities, tool registration, backend as the final boundary — remains with `dataops/docs/dataops-connector-development-spec.md`.

## Consequences

A DataOps standalone release now carries seven registry plugins beyond the Plus set, so the standalone manifest and the deployment's profile both grow with the variant instead of with a build directory. The next runtime line must regenerate the manifest at that version and either publish a compatible `dsh-video-preview` or keep its omission; the verifier fails the image in both cases until one is chosen.

The two private plugins remain the only requirement a source checkout cannot satisfy by itself: an image build needs tarballs built from `dsh-plugins-plus`, and the assembler stops the build when they are missing or at the wrong version.