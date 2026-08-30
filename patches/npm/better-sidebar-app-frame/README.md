# Better Sidebar app-frame patch

English | [中文](README.zh.md)

This data-only npm package carries one temporary compatibility payload for the verified `dsh-better-sidebar 0.17.1` target. `dsh-plus apply` selects and applies one payload while materializing the npm profile; installing the package does not mutate dependencies through an npm lifecycle script.

The single variant covers only the verified `0.17.1` target. The local `0.17.0` artifact used by accepted production already contains the same AppFrame and Host-route behavior and requires no payload. The exact patch-package, DSH, target-package, variant, and payload selection belongs to the deployment lock.

The patch preserves the accepted app-frame spacing used by the Plus Web composition. Its upstream pull request, owner, and retirement status remain in the Plus curated-plugin manifest. Remove this package from the Plus distribution when the tracked Better Sidebar upstream release contains the same app-frame behavior.

## Model Experience

This package does not register a Cordis plugin, add model-visible text, alter token usage, or affect KV-cache reuse. Its target plugin owns any runtime and model experience.

## Known Limitations and Deferred Work

The package supports only the declared target package and payload. It does not provide a fallback implementation when exact patch application fails.
