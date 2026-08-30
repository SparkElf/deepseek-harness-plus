# Mobile Bridge serialized-actions patch

English | [中文](README.zh.md)

This data-only npm package carries one temporary compatibility patch for the verified `@sparkelf/dsh-mobile-bridge 0.2.8` target. `dsh-plus apply` selects and applies its payload while materializing the npm profile; installing the package does not mutate dependencies through an npm lifecycle script.

The compatibility declaration covers only the verified target version. The exact patch-package, DSH, target-package, variant, and payload selection belongs to the deployment lock.

The patch preserves serialized action execution required by the accepted Plus mobile workflow. Its upstream pull request, owner, and retirement status remain in the Plus curated-plugin manifest. Remove this package from the Plus distribution when the tracked Mobile Bridge upstream release contains the same serialized-action behavior.

## Model Experience

This package does not register a Cordis plugin, add model-visible text, alter token usage, or affect KV-cache reuse. Its target plugin owns any runtime and model experience.

## Known Limitations and Deferred Work

The package supports only the declared target package and payload. It does not provide a fallback implementation when exact patch application fails.
