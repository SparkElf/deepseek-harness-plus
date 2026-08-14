# Plus Diff Protocol

[English](DIFFS.md)

Plus 维护两份独立注册表，让你能区分一个改动是在修改 Harness 本身，还是在修改其周边的社区层。

| 注册表 | 负责内容 |
| --- | --- |
| `diffs/core/registry.yaml` | 上游 Harness 行为和核心插件改动。 |
| `diffs/community/registry.yaml` | 社区插件、预设、安装器、部署和治理资产。 |

每条记录包含稳定 ID、状态、功能、来源仓库、上游基线、影响文件、插件角色、兼容性、owner 和验证方式。行号会随上游同步变化，因此不记录。

## 状态

`planned` 是已接受但尚未改变生产行为的工作。`active` 是已发布的本地差异。`retired` 是已进入上游或已经从本地移除的工作。

## 插件编排

社区插件或预设在 `presets/compositions/registry.yaml` 中声明生效的工具名、路由、设置命名空间、UI slot、持久化 owner、权限和依赖。治理校验会拒绝重复的生效声明，因为插件生态不能依赖隐式覆盖顺序。

## 维护

只要变更影响任一注册表或编排清单，就使用 [dsh-maintain-diffs](.agents/skills/dsh-maintain-diffs/SKILL.md)。评审前运行 `pnpm run verify:plus-governance`。
