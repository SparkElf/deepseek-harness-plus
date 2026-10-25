# Agent Note: Durable teammate model routes and archival

Status: implemented

[English](2026-10-22-team-member-model-routes-and-archival.md) | 中文

## Problem

Team 成员创建时只记录 continuable-subagent provider（`spawn` 或 `fork`），并继承 Lead 在那一刻使用的 LLM provider、model 与 reasoning effort。roster 能报告 live 成员的创建 options，但 inactive 成员会丢失该信息，也没有任何操作可以重新路由现有成员。希望使用更便宜或更快 teammate 的部署只能创建新成员；长期运行的 teammate 也无法在不被替换的情况下从上游 provider 或 model 故障中恢复。

roster 同样没有退役操作。删除成员记录会破坏持久回放，使保留的名字与成员名额记账失效，并丢弃指向成员 Session 的唯一持久链接。因此 Team 需要一种把已完成成员移出活动协作、同时保留全部持久事实的方法。

## Decision

`TeamMemberSnapshot` 在现有 version-2 payload 中新增四个可选字段：`modelProvider`、`model`、`reasoningEffort` 与 `archived`。现有的 `provider` 字段保留其「创建 child 的 continuable-subagent provider」含义。由于所有新字段都是可选的，本决策之前写入的日志可以原样回放；没有路由字段的旧成员只报告其 live Session 路由。`TeamMemberView` 在不变的 `provider` 与 `diagnostics` 旁暴露持久化的 `modelProvider`、`model` 与 `reasoningEffort`；`archived` 只出现在通过包含归档的读取返回的行上。

### Route resolution

创建时，显式的 `modelProvider` 或 `model` 按字段优先，每个缺失值从 Lead 的当前路由继承。与 continuation provider 的继承规则一致，Lead 最近的 request header 拥有该路由；Lead 首次请求之前回退到创建 options。若请求指定了显式路由或 effort，但两个来源都没有可用路由，则以 `TEAM_INVALID_MODEL_SELECTION` 失败，而不是创建一个无法运行的成员。解析后的路由写入 provisioning 快照，并作为 `request.agentOptions` 传给 `ctx.subagents.startContinuable`，因此初始调用与持久记录保持一致。

### Update timing

`updateTeammate()` 仅限 Lead，作用于未归档且 active 的成员。部分请求中未指定的字段继承成员已存储的路由；对于路由持久化之前创建的成员，则回退到 Lead 的路由。改变 `modelProvider` 或 `model` 而未指定 effort 时，恢复所选模型的默认 effort；仅指定 effort 的请求保留已存储的路由。

成员快照先追加并 flush。对于 live 成员，服务随后安装 `@deepseek-ai/dsh-agent` 的 Agent 作用域 model-selection 监听器，并设置其 `current` selection，因此下一次 prompt assembly 与 request 使用新路由；已经进行中的请求不会被中断。对于 inactive 成员，持久路由由 `agent/session-start` 观察者应用。该观察者在发布期间同步运行，早于 continuation manager 提交排队的首条 prompt，因此持久 Team 路由会覆盖 child continuation descriptor 中冻结的创建时路由。已安装的监听器在成员 Agent 或 Team 运行时 dispose 时释放，因此插件替换不会累积陈旧的 selection 状态。

### Archival

`archiveTeammate()` 仅限 Lead，拒绝仍在 provisioning 的成员，并以 `TEAM_MEMBER_ARCHIVED` 拒绝已经归档的成员。它追加一份 `archived: true` 的完整成员快照，phase 保持不变，然后通过 continuation owner 释放任何 live Activation。投影把归档视为终态：之后的成员事件都不能修改已归档行。roster 读取默认省略归档行，除非调用方显式要求；`send_message`、`interrupt_agent` 与成员更新都以同一稳定错误码拒绝归档 target。mailbox 投递绝不会冷恢复已归档目标，因此归档前排队的条目会保持排队，而不会唤醒退役成员。Session、对话历史、保留的名字与成员名额都会保留。

### Projection transitions

成员事件现在允许 `provisioning -> active|failed`、`active -> active` 与 `failed -> failed`。名字、subagent provider 与 context 仍然不可变；成员不能回到 provisioning，`active -> failed` 仍然非法，新成员必须从 provisioning 开始，首条记录不能是归档状态。这些规则让完整快照更新可回放，而无需增加第二种事件类型。

## Alternatives considered

**单独的 `team/member/model` 事件。** 否决：roster 已经在同一投影与转换校验器下读取完整成员快照。第二种事件类型会拆分同一行的权威来源、复杂化恢复，并且仍需要相同的可选字段兼容工作。

**带迁移的 version-3 payload。** 否决：新增字段不改变事件结构或其解释。可选字段让已发布日志保持可读，无需新一代格式、回退解码器或 format-version 提升。

**修改 continuation descriptor。** 否决：descriptor 是 child Session 的仅追加创建记录，不是 Lead 拥有的可变状态。重写它会混合两个日志的事务归属，并在 Team 服务之外改变冷恢复行为。

**删除成员记录而不是归档。** 否决：回放会忘记 child，保留的名字与名额记账会被复用，指向成员历史的持久链接也会消失。归档表达退役而不破坏这些事实。

**只在成员创建时安装 selection。** 否决：live 更新永远不会到达下一次请求，冷恢复也会继续使用冻结的 descriptor 路由。在每次 Session 启动时从持久快照安装，才让回放与冷启动保持一致。

**把 `agent.options.model` 当作 roster 来源。** 否决：Agent options 是创建事实；运行期 model-selection 覆盖不会重写它们，而 inactive 成员根本没有 live Agent。持久成员快照是唯一能同时挺过这两种情况的权威来源。

## Testing

`packages/experimental/agent-team/tests/team.spec.ts` 覆盖创建时的继承与显式路由、同一 turn 下一步可见的 live 路由更新、冷恢复时应用的 inactive 更新、部分与非法更新解析、Lead-only 权限、dispose 错误、归档列表过滤与稳定拒绝码、名字与名额保留、历史可读、provisioning 成员拒绝、归档成员的 session-start 与 mailbox 恢复，以及禁止冷恢复的投递守卫。`tests/projection-events.spec.ts` 固定旧 payload 可读性、路由更新、归档终态与首条记录拒绝。`packages/experimental/tool-agent-team/tests/tool-team.spec.ts` 覆盖 `spawn_teammate`、`update_teammate`、带 `include_archived` 的 `list_agents` 与 `archive_teammate` 的模型侧 schema。两个包都通过各自的定向测试套件，两包 coverage 运行保持每文件 100% 门槛，受影响的包通过 typecheck。

## Related decisions

child 路由参数、adapter preflight 与 fork cache 限制仍由[model-selected subagent routes](2026-08-18-model-selected-subagent-routes.zh.md)拥有。用户选择 subagent 路由的授权策略仍由[user-authorized subagent model routes](2026-08-24-user-authorized-subagent-model-routes.zh.md)拥有；Team 成员只由 Lead 创建，因此不增加单独的用户路由授权。provider 或 model 变更时发出的持久通知仍由[model switch notice](2026-09-07-model-switch-notice.zh.md)拥有。Team 身份、mailbox、任务与共享 checkout 决策仍由[durable Agent Teams over continuable children](2026-08-05-agent-teams.zh.md)拥有。

## Consequences

每个新 teammate 现在都会在快照中携带 LLM 路由，即使它是继承来的；因此 roster 可以为 inactive 成员作答，后续更新也有完整基线。代价是每条成员记录多几个字节，以及需要让路由字段与 model-selection 扩展点保持一致。

只有在 Team 服务能从 live Lead 解析成员时，持久路由才故意优先于 continuation descriptor。若宿主在没有 live Lead 的情况下直接恢复 teammate Session，它仍会使用 descriptor 的创建时路由。归档会让成员永远留在 Lead 日志中：它不释放名字、不减少 `maxMembers` 占用，并会让归档前排队的 mail 保持未投递。这些是显式的退役语义，而不是删除保证。
