# @sparkelf/dsh-patch-subagent-settings-presets

English | [中文](README.zh.md)

This data-only package routes the two built-in delegation rows in each official shipped Agent preset to `@sparkelf/dsh-plugin-subagent-settings`. The continuous row reads `subagent`; the one-shot fork row reads `subagent-fork`. Disabled Codex and Claude Code provider rows remain official and unchanged.

The target is the exact official source base `cd5ef8148158c3a752a658978873241fdf8e2bbc`. The Plus apply command verifies the base ancestry and payload before applying it. This package has no JavaScript entry, Cordis lifecycle, install script, or capability implementation.

Retire this package when official Agent presets expose a deployment overlay for shipped row replacement or ship equivalent settings-backed rows.
