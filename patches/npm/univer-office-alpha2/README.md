# Univer Office alpha.2 patch

English | [中文](README.zh.md)

This data-only npm package directly patches the exact `dsh-univer-office@0.2.12` artifact. It preserves the existing DSH alpha.2 Settings, Tool-input, peer-version, and Viewer socket-lifecycle compatibility changes. It also backports `univer_new.templateFile`, complete non-overwriting `.univer` copies, reversible read-only template-root registration for trusted Host plugins, and a generic parent-to-Viewer external-font manifest channel; output targets remain session-workspace confined, while registered external template assets are staged inside that workspace before Gateway creation. Domain plugins continue to own and serve their font binaries.

The package inserts no shim, adapter, fallback, or second runtime path into the DSH Host. Its single variant covers DSH `>=0.1.2-alpha.2` with the exact target. Remove this package after an upstream release includes both native alpha.2 compatibility and authorized template creation.

## Model Experience

This package registers no Cordis plugin. `dsh-univer-office` continues to own its bundled skills, tools, Gateway, Viewer, and model experience; the patch extends its existing `univer_new` Tool with the optional `templateFile` argument and does not bundle domain templates.

## Known Limitations and Deferred Work

Patch application fails loud; there is no fuzzy application or unpatched-target fallback.
