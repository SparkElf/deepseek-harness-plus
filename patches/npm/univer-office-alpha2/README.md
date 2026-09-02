# Univer Office alpha.2 patch

English | [中文](README.zh.md)

This data-only npm package directly patches the exact `dsh-univer-office@0.2.12` artifact. DSH alpha.2 removed the runtime `settingsNamespace` export; the target already owns the literal `univer-office` namespace, so the payload removes the helper import, passes that literal directly to the public Settings service, and records the verified alpha.2 Host peer versions in the target manifest. Real GPT tool calls also materialize omitted optional strings as blanks, so the target's Tool ingress treats blank optional strings as absent while retaining every action-required field error. The exact bundled Viewer sends collaboration frames only while its native WebSocket is open, preventing a close-time console error without changing global WebSocket behavior. Automatic floating live previews now default to off, so submitting a message does not cover the conversation; users can still opt in from Univer Office settings, and conversation review cards remain available.

The package inserts no shim, adapter, fallback, or second runtime path into the DSH Host. Its single variant covers DSH `>=0.1.2-alpha.2` with the exact target. Remove this package after upstream publishes native alpha.2 Settings, Tool-input, and Viewer socket-lifecycle support.

## Model Experience

This package registers no Cordis plugin and adds no model-visible text. `dsh-univer-office` continues to own its bundled skills, tools, Gateway, Viewer, and model experience.

## Known Limitations and Deferred Work

Patch application fails loud; there is no fuzzy application or unpatched-target fallback.
