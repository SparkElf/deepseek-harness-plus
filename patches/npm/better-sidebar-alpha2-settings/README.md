# Better Sidebar alpha.2 Settings patch

English | [中文](README.zh.md)

This data-only npm package carries one compatibility payload for the verified stable `dsh-better-sidebar 0.17.1` target. DSH alpha.2 removed the runtime `settingsNamespace` export; the payload keeps the target's `SettingsConflictError` import and passes its existing literal namespace directly to the public Settings service.

The single variant covers DSH `>=0.1.2-alpha.2` with exactly `dsh-better-sidebar 0.17.1`. The target already owns its schema, reads, writes, conflict handling, and lifecycle; this patch changes only the removed namespace helper call. Remove the package when a stable Better Sidebar release carries the alpha.2 Settings contract.

## Model Experience

This package does not register a Cordis plugin, add model-visible text, alter token usage, or affect KV-cache reuse. Better Sidebar owns its runtime and model experience.

## Known Limitations and Deferred Work

The package supports only the declared target and provides no fallback when exact patch application fails.
