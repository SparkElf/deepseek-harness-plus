# @sparkelf/dsh-patch-subagent-settings-presets

English | [中文](README.zh.md)

This data-only package routes the two built-in delegation rows in each official shipped Agent preset to `@sparkelf/dsh-plugin-subagent-settings`. The continuous row reads `subagent`; the one-shot fork row reads `subagent-fork`. Disabled Codex and Claude Code provider rows remain official and unchanged.

The target is the exact official source base `fb2c4b9e698e30edb738bca4cf0618587db7d203`. The Plus apply command verifies the base ancestry and payload before applying it. This package has no JavaScript entry, Cordis lifecycle, install script, or capability implementation.

Retire this package when official Agent presets expose a deployment overlay for shipped row replacement or ship equivalent settings-backed rows.
