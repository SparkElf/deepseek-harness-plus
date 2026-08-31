# @sparkelf/dsh-patch-subagent-settings-presets

[English](README.md) | 中文

该data-only package把每个official shipped Agent preset中的两条built-in delegation rows路由到`@sparkelf/dsh-plugin-subagent-settings`。continuous row读取`subagent`，one-shot fork row读取`subagent-fork`。disabled Codex与Claude Code provider rows保持official且不变。

target是exact official source base `0a53fb55bea101816fa226bb964ae2bed71c343b`。Plus apply command在应用前验证base ancestry与payload。本package没有JavaScript entry、Cordis lifecycle、install script或capability implementation。

official Agent presets提供可替换shipped rows的deployment overlay，或直接发布等价settings-backed rows后，retire本package。
