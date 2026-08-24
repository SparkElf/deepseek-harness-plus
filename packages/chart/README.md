# chart/ — interactive visualization capability family

English | [中文](README.zh.md)

Interactive data visualization for model-prepared results. Query execution stays outside the capability, while Harness may use ordinary Code Mode when a program is the clearest way to synthesize an accurate interactive option. The model-facing tool lives on the agent plane; the ECharts renderer lives with browser UI packages.

Both plugins are opt-in and stay out of shipped default agent presets and the default Web browser roster. A deployment composes the tool and browser renderer explicitly when it wants the full interactive experience.

| Package | Role | ctx key |
|---|---|---|
| [`tool-chart/`](tool-chart/README.md) | Agent-plane `render_chart` tool; records complete replayable JSON option metadata. | `ctx.tools` |
| [`../client/ui-chart/`](../client/ui-chart/README.md) | Browser-plane keyed ECharts presentation for durable `render_chart` results. | keyed `tool.call.toolview` |

The child READMEs own the tool, replay, Code Mode, and renderer contracts.
