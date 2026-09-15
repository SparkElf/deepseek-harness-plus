# @sparkelf/dsh-patch-subagent-settings-presets

English | [中文](README.zh.md)

This data-only package routes the two built-in delegation rows in each official shipped Agent preset to `@sparkelf/dsh-plugin-subagent-settings`. The continuous row reads `subagent`; the one-shot fork row reads `subagent-fork`. Disabled Codex and Claude Code provider rows remain official and unchanged.

It also sets `disabled: true` on the shipped `ralph` row in all three presets, following official 0.1.6 (`feat(presets): disable ralph in the default compositions`): the tool restricts itself to runs the human explicitly asked for, and its completion is a worker self-report rather than an independent evaluation, so a shipped composition should not offer it. A session that wants it can duplicate the preset and drop the `disabled` key.

The target is the exact official source base `fb2c4b9e698e30edb738bca4cf0618587db7d203`. The Plus apply command verifies the base ancestry and payload before applying it. This package has no JavaScript entry, Cordis lifecycle, install script, or capability implementation.

Retire this package when official Agent presets expose a deployment overlay for shipped row replacement or ship equivalent settings-backed rows.
