# @sparkelf/dsh-patch-subagent-settings-presets

[English](README.md) | 中文

该data-only package把每个official shipped Agent preset中的两条built-in delegation rows路由到`@sparkelf/dsh-plugin-subagent-settings`。continuous row读取`subagent`，one-shot fork row读取`subagent-fork`。disabled Codex与Claude Code provider rows保持official且不变。

它还把三个preset中shipped的`ralph` row设为`disabled: true`，follow官方0.1.6（`feat(presets): disable ralph in the default compositions`）：该tool把自身限定在人类明确要求的运行上，而它的completion是worker self-report而非independent evaluation，因此shipped composition不应提供它。需要它的session可以duplicate该preset并去掉`disabled`键。

target是exact official source base `fb2c4b9e698e30edb738bca4cf0618587db7d203`。Plus apply command在应用前验证base ancestry与payload。本package没有JavaScript entry、Cordis lifecycle、install script或capability implementation。

official Agent presets提供可替换shipped rows的deployment overlay，或直接发布等价settings-backed rows后，retire本package。
