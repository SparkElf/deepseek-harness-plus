---
description: "在一个会话中运行一个小型具名 agent 团队：成员之间的持久消息与共享任务板，供组合实验性 Team 插件的部署方阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team

[English](README.md) | 中文

## 概述

`dsh-experimental-agent-team` 把一个编码会话变成一个小型工作团队：会话中的 agent 成为 Lead，创建具名 teammate 处理委派的工作，与它们交换持久消息，并在公共任务板上跟踪共享任务。每个 teammate 都可以使用创建时选定的 LLM 路由；归档的 teammate 会离开活动 roster，但保留其 Session 与历史。消息与任务状态能挺过崩溃、reload 与中断，因此离线的 teammate 会在恢复后收到排队的消息。它本身不提供任何工具——请挂载兄弟包 `dsh-experimental-tool-agent-team`，让模型能够创建 teammate、选择它们的模型、给它们发消息并使用任务板。它以实验性名称公开发布、不承诺稳定性，并且需要持久会话存储才能激活。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当一个 agent 应该在自己的工作目录中运行一支小型具名助手团队、且消息与任务状态需要挺过崩溃与重启时，把本包加入组合。它本身不带工具：请与 `@deepseek-ai/dsh-experimental-tool-agent-team` 一起挂载，让模型能够创建 teammate、给它们发消息并使用任务板。

### 何时选择

当多个 agent 必须在同一个共享工作区协作、且 roster、消息与任务状态需要挺过崩溃与重启时，选择它。当 teammate 需要独立工作目录、多个进程需要协调同一支团队、或任务 owner 需要自动释放时，请不要选择——这些都不受支持。团队功能需要持久会话存储才能激活。

### 最小工作配置

<a id="smallest-working-setup"></a>

对现有组合的最小增量是持久会话存储加两个 Team 包：

```yaml
# smallest team setup — durable storage plus both Team packages
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
- name: '@deepseek-ai/dsh-experimental-agent-team'
- name: '@deepseek-ai/dsh-experimental-tool-agent-team'
```

工具安装后，模型会按请求完成其余工作——例如先「创建一个名为 reviewer 的 teammate 检查 diff」，再「把变更摘要发给 reviewer」。所有限制都是可选的，并在启动时校验：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxMembers` | `8` | 一支团队最多可创建的 teammate 数，包括失败的 |
| `maxTasks` | `256` | 任务板上最多的活动任务数 |
| `maxPendingMessagesPerMember` | `64` | 单个成员最多可排队的消息数 |
| `maxMessageBytes` | `65,536` | 单条发送消息的最大尺寸 |
| `disposalTimeoutMs` | `5,000` | 关闭清理允许的时间 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-agent-team)是每个受支持字段及其 JSDoc 的穷尽式真源。

### Teammate

请 Lead 创建 teammate：给它一个唯一的小写名字（例如 `reviewer`）并描述其职责。teammate 可以 fresh 启动（不携带 Lead 对话的任何记忆），也可以作为 fork 启动（继承 Lead 已完成的轮次）；创建请求决定用哪种。teammate 名字是永久的——即使创建失败的 teammate 也保留其名字，任何名字都不会被复用。

roster 显示每个成员的职责（`lead` 或 `teammate`）与当前状态：`running`、`idle`、`inactive`（存在但未加载的成员）、`provisioning` 或 `failed`。未加载的成员会在唤醒后收到其消息。

每个 teammate 还携带一条持久的 LLM 路由。`spawn_teammate` 接受 `provider`、`model` 与 `reasoning_effort`；每个省略的值都从 Lead 的当前路由继承，因此最常见的「只换模型」只需提供 `model`。roster 对已加载与 inactive 成员都会报告持久化的 `model` 与 `modelProvider`。`update_teammate` 修改现有成员的 provider、model 或 effort；变更持久保存，live 成员在下一步采用，inactive 成员在下次恢复时采用。改变 provider 或 model 而未指定 effort 时，会恢复所选模型的默认 effort。

只有 Lead 可以创建、更新、归档或中断 teammate。

### 归档

`archive_teammate` 让 teammate 退役而不删除任何内容。归档成员离开默认 roster，也不能再收到消息或中断；其 Session、对话历史、名字与 roster 名额都会保留，`list_agents` 仍可通过 `include_archived: true` 显示它。名字仍然永不复用，归档成员也仍然占用 `maxMembers` 名额。归档 live teammate 时，会在归档记录提交后停止其当前 Activation。

### teammate 之间的消息

任何成员都可以向任何其他成员或 Lead 发送消息。live 成员会立即收到；离线成员的消息会排队，并在其恢复后到达。消息不会丢失，也绝不会重复投递。

每条消息都使用 Steer：running target 在最近的步骤边界收到消息，idle target 启动一个轮次，inactive teammate 则冷恢复。发送方始终能看到结果——target inbox 已接受，或在投递暂时不可用时保留为 queued。排队的消息已经安全存储，因此绝不能重发。

### 共享任务板

任何成员都可以添加任务，包含标题、详情、对其他任务的可选依赖，以及可选的文件触及提示。只有其全部依赖完成后，任务才可 claim。

任务有 owner：成员 claim 任务开始工作，完成后标记完成、释放回板或重新打开；Lead 可以把任务分配给任意成员。每次变更都是 compare-and-set：基于过期副本的更新会被拒绝，因此两个成员不会悄悄覆盖彼此的成果。

当两个 in-progress 任务计划触及重叠路径时，文件提示会产生警告——它们绝不阻止任何操作。已删除任务保留在历史中，但从活动列表中消失。

### 等待与中断

成员可以等待下一次团队变化——teammate 的状态、新消息或任务更新——而不必反复轮询；等待只报告是否超时，调用方随后重新读取当前状态。

Lead 可以停止 teammate 的当前轮次，而不会删除其排队的消息；任务归属不变。

### 成功与失败的表现

成功的表现是：teammate 出现在 roster 中、消息报告 `accepted` 或 `queued`、任务 revision 随每次变更递增。可能的失败会以具体错误报告，而不会悄悄破坏状态：发给不存在的成员名字、claim 尚未就绪的任务、用过期 revision 编辑、或超出成员上限创建 teammate。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本服务建立在一个分离与三项承诺之上：

- **持久日志，派生状态。** Lead Session 日志是唯一真源；roster、mailbox 与任务状态每次读取都从中回放。
- **进程内归属。** 所有协作都位于单一进程；保证是重试加去重，绝不是跨进程共识。
- **显式权限。** 每个服务方法都接收精确的 live 调用 `Agent`；只有 Lead 可以 spawn、reassign 或 interrupt。
- **边界大声失败。** 每个限制都是经过校验的部署值，耗尽时报告类型化错误，而不是复用 id 或名字。

[Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责身份、mailbox、任务与共享 checkout 决策。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、服务注册、恢复调度 |
| [`src/roster.ts`](src/roster.ts) | Team 身份、成员关系解析、provisioning、模型路由变更、归档与 roster 拆除 |
| [`src/model-selection.ts`](src/model-selection.ts) | 为 live 成员安装并释放 Agent 作用域的 model-selection 监听器 |
| [`src/mailbox.ts`](src/mailbox.ts) | 持久队列、目标本地投递、确认与恢复 |
| [`src/task-board.ts`](src/task-board.ts) | 任务 CAS 命令、DAG 校验与派生视图 |
| [`src/journal.ts`](src/journal.ts) | 串行化的 Lead 日志事务与提交通知 |
| [`src/projection.ts`](src/projection.ts) | 解码并校验 Team 事件的严格回放投影 |
| [`src/activity.ts`](src/activity.ts) | 一次性变更等待者与 dispose 释放 |
| [`src/lifecycle.ts`](src/lifecycle.ts) | 共享准入截止与有界结算 |
| [`src/invariant.ts`](src/invariant.ts) | 在 append 前回放候选事件的不变式伴生插件 |

### Team 身份与 roster

每个普通运行时 root 都是一个隐式 Team 的 Lead，其 `TeamId` 等于 `SessionId`；不存在创建事件，持久状态从第一条成员、消息或任务记录开始。`spawnTeammate()` 先追加并 flush 一条 `provisioning` 成员记录，再要求配置的 provider 创建预留 child；provider 失败会追加一条持久的 `failed` 成员。fresh child 不携带 Lead 历史；fork child 只捕获一次 Lead 的已完成 turn 前缀。恢复把未终结的 provisioning 记录对照 child 独立持久化的 Session 进行对账：直接 parent 与 continuable descriptor 匹配、且初始用户消息已记录则产生 `active`，其他任何情况都产生 `failed`。如果恢复在同进程竞争中先完成，creator 会接受终态，或报告 `TEAM_PROVISIONING_CONFLICT` 并 drain 该 child。名字由第一条 provisioning 记录保留，且永不复用。

### 成员模型路由

`provisioning` 成员记录保存生效的 LLM 路由（`modelProvider`、`model` 与可选的 `reasoningEffort`）。这些字段在 version-2 payload 中是可选的，因此成员模型选择之前写入的日志可以原样回放；这类旧成员只报告其 live Session 路由。创建时路由可以显式指定，或从 Lead 最近的 request header 继承；Lead 尚未发起请求时回退到其创建 options。`updateTeammate()` 在 Lead 日志串行化器下追加一份新的完整成员快照。live Agent 通过服务安装的 Agent 作用域 model-selection 监听器接收该路由；inactive 成员在其 Session 启动时、首条排队 prompt 准入之前接收。continuation descriptor 仍冻结创建时的路由，因此持久 Team 路由会在每次激活时覆盖它。已安装的监听器随 Team 运行时或成员 Agent 一起释放。

### 归档

`archiveTeammate()` 以完整成员快照提交 `archived: true`，然后释放任何 live Activation。投影把归档视为终态：之后的成员事件都不能修改已归档行。roster 读取默认省略归档行，除非显式要求；target 解析会以 `TEAM_MEMBER_ARCHIVED` 拒绝它们。mailbox 投递绝不会冷恢复已归档目标，因此归档前排队的消息会保持排队，而不会唤醒退役成员。

### 持久 mailbox

`sendMessage()` 校验 peer 成员关系，追加 `team/message/queued` 并在尝试投递前 flush。目标消息以 `Team message <id> from <name>:` 开头，并在 `TeamMessageSource` 中保留同一 id 与发送者。只有目标 Session 在 pending inbox 或已记录历史中持久持有消息身份后，才会以 `team/message/delivered` 确认投递。即时准入按目标与持久队列顺序串行化；恢复按同一顺序重新投递 queued-minus-delivered 记录。重试前会同时折叠 live 与持久目标 inbox／历史状态，因此 inbox 已接受但模型尚未 claim 时发生崩溃不会复制消息。该保证是进程内重试加 target Session 去重，而不是跨进程 exactly-once 投递。

投递给 Lead 时直接调用 `Agent.steer()`。投递给 teammate 时使用 continuation owner 的 host-only Steer 路径；该路径会保留 Team 发送者 source，同时授权 Lead-to-child edge 并冷恢复 inactive target。sibling 消息绝不会通过公开的相邻 Agent 消息操作伪装成 Lead。

### 共享任务板

任务是完整版本化快照；每次变更都携带 `expectedRevision`，陈旧调用方会收到 `TEAM_TASK_STALE_REVISION`，而不会覆盖更新的值。数字 `task-<n>` id 的后缀必须是安全整数，id 空间耗尽时报告 `TEAM_TASK_LIMIT`，而不是复用最后一个 id。已删除任务作为 tombstone 保留以供回放与维持 id 稳定，但不占用 `maxTasks`，也不出现在 `listTasks()` 中。`writeScopes` 是规范化后的 workspace 相对前缀；视图会对与 in-progress 任务的重叠发出警告，但绝不阻止 claim 或授予写权限。

### 等待与中断

`waitForChange()` 等待注册之后发生的下一条 roster、task、mailbox 或实时状态边，时长从 10 秒到 1 小时，并且只报告是否超时；运行时 dispose 会释放当前等待。取消会保留 Error reason；非 Error reason 则通过 `TEAM_WAIT_ABORTED` 报告。`interrupt()` 仅限 Lead，委托 continuable-subagent 的 interrupt 路径，以 `keepInbox` 只取消 live teammate 的当前 turn；它既不释放任务 owner，也不删除持久 mail。

### 持久性模型

Team 事件追加到精确的 live Lead Session，并在操作报告成功或唤醒等待者之前 flush。`team/member`、`team/task`、`team/message/queued` 与 `team/message/delivered` 仅存在于日志：它们从不进入会话表面，因此派生模型历史不受协作记录影响。顺序与时间由 Session event 的 `seq` 与 `time` 负责，快照不重复保存。`./invariant` 伴生插件把每条候选 Team event 对照已提交前缀回放，并在 append 前拒绝非法转换。

### Dispose

dispose 会关闭准入、中止并等待已获准的创建与 mailbox dispatch 事务，再让 continuation owner 释放 roster 中确切的 live direct child 及其后代；Lead 的非 Team continuable child 不受影响。cleanup 失败会让 dispose 明确失败，并以 `disposalTimeoutMs` 为上限。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享子系统类型逐步进入工具表面与设计背后的决策。

- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与 `ctx.agentTeams` 服务 API。
- [tool-agent-team 包](../tool-agent-team/README.zh.md)——让模型创建、消息与协调 teammate 的工具。
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)——身份、mailbox、任务与共享 checkout 决策。
- [成员模型选择与归档 Agent Note](../../../.agents/notes/implemented/feature/2026-10-22-team-member-model-routes-and-archival.zh.md)——持久路由归属、生效时机与归档语义。
- [实验包决策](../../../.agents/notes/implemented/architecture/2026-08-18-experimental-agent-teams-packages.zh.md)——位置、公开发布与依赖隔离。

-----

<a id="model-experience"></a>

### 浏览器 Remote

`TeamService` 除了 roster、mailbox、task 与 lifecycle operation，还直接负责生成式 `agentTeams/view`、`agentTeams/createTask` 与 `agentTeams/updateTask` Remote method。`./remote` 导出由 Web UI 挂载的 Client contribution，`./client` 则重新导出可在浏览器 compilation face 中安全使用的 request、view 与 task mutation result type。Typert 在外层 `RemoteResult` 中保留 transport failure；create 与 update rejection 则作为 transport 成功响应中的显式 domain result，其中过期的 update revision 会区分为 task conflict。

## 模型体验

### Peer 消息

#### 模型看到什么

每条已投递 peer 消息都是用户角色消息。第一个短文本块包含稳定消息 id 与发送者，之后原样附加发送者的内容块。roster、task 与 mailbox 记录仅存在于日志，绝不进入派生模型历史。

#### Token 影响

每次 peer 投递都会把发送者前缀与消息内容加入 target 历史。任务与 roster 变更不增加模型 token；其面向模型的呈现属于 `@deepseek-ai/dsh-experimental-tool-agent-team` 结果。

#### KV Cache 影响

Peer 消息追加在 target 可复用历史前缀之后。冷恢复会先复用持久对话，再追加尚未投递的消息。

### 成员路由变更

#### 模型看到什么

成功的 `update_teammate` 会改变成员下一次请求所用的 provider、model 与 effort。provider 或 model 变更还会把共享的 model-selection 通知加入该请求，说明旧路由与新路由。

#### Token 影响

每次 provider 或 model 变更会新增一条简短的用户角色通知，追加在成员既有历史之后。仅 effort 变更不会新增通知。

#### KV Cache 影响

通知与变更后的 request header 落在可复用前缀之后；此前的 turn 直到该点仍然可复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明一支团队目前不能做什么、或何时需要特别运维。它们是当前包约束，不是与其他协作机制的对比。

- **实验原型，无稳定性承诺**——本包公开发布，但孵化期间约定仍可自由变更。
- **单进程、共享 checkout**——成员共享 cwd，修改立即可见；本包不提供 worktree、远端成员、merge 或文件锁。
- **write scope 仅作提示**——Bash、formatter、代码生成器与直接外部写入可以绕过文件版本检查；Lead 必须协调 owner 并检查最终 diff。
- **扁平且不可变的 roster**——只有 Lead 可以创建直接 teammate；不支持嵌套 Team、重命名、取消归档或名字复用。
- **归档成员保留身份与邮件**——归档绝不删除 Session、释放名字或释放成员名额；归档前排队的消息绝不会投递给退役成员。
- **仅宿主恢复会绕过 Team 路由**——在没有 live Lead 的情况下恢复 teammate Session（例如由宿主直接打开）时，会使用其 continuation descriptor 中冻结的路由，而不是之后的 `update_teammate` 路由。
- **不会自动释放 owner**——idle、interrupt、进程退出与工作失败都不会释放任务 owner。
- **mailbox 不保证跨进程 exactly-once**——不支持多个 harness 进程并发操作同一 Team。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。

#### Promotion

promotion 到产品角色组需要按[实验子树规则](../AGENTS.md)审查公共约定、限制、测试证据、发布载荷、运行时依赖与具名稳定 owner。

#### 未来方向

尚未决定的探索方向包括嵌套 Team、自动释放 owner 的策略、跨进程 mailbox 事务，以及通过 worktree 实现文件系统隔离；这些都没有承诺。

</details>
