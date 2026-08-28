# Agent Note: 权限控制保留空白会话 Hero

Status: implemented

[English](2026-08-27-permission-controls-preserve-blank-session.md) | 中文

## Problem

编辑器通过已记录的 `/permission <preset>` 命令改变某个 Session 的权限 preset。Host 把所有 `command/run` 都归为对话历史，因此这次控制操作会把 `SessionSummary.blank` 改为 false。虽然没有 prompt 或用户可见命令开始对话，客户端仍会用对话视图替换新会话 Hero，并显示通用 permission 命令卡。

同一组控件还有两个呈现缺口。内建权限名称与会话日志 Header 操作绕过各自的 locale 字典，附件贡献则渲染在权限模式之后，而非紧邻前置命令操作。

## Decision

Host 的 `startsSessionHistory` fold 与客户端 `SessionManager` 的实时帧镜像都把 `command/run(name='permission')` 视为持久控制状态，而不是对话历史。`turn/start` 与所有其他 `command/run` 仍属于会话活动。`sessionListMetadata` 投影使用 state version 2，因此旧缓存中的 non-blank 结果不会在新 fold 下复用。权限事件仍保留在 Session 日志中；New Session 复用同一个空白 Session，因此选中的 preset 也会保留。

conversation 与 permission-settings locale 分别拥有三个内建权限 preset 的显示名称和各自的完全访问确认文案。内建集合以外的 Host 自定义名称继续使用现有 Title Case 转换。Session-log export locale 拥有 Header 按钮的可见标签与无障碍标签。`conversation.input.left` 列表紧随前置命令 launcher，并位于 permission 与 plan 模式之前；附件插件仍拥有回形针操作及其状态。

## Alternatives considered

**在 `ConversationRoot` 中阻止页面切换。** 权威摘要仍会让 Session 出现在列表中且无法复用，重连或冷加载也会恢复错误状态。呈现层无法修正 Host 的活动语义。

**从空白编辑器写入全局权限默认值。** 该操作寻址一个已存在的 Session 及其持久投影。修改未来会话的默认值会转移所有权，也无法通过同一条已记录路径更新当前 Session。

**激活后隐藏 permission 命令卡。** 这只会遮住一个症状，Hero 切换、Session 列表可见性与 New Session 复用仍然错误。

## Consequences

空白 Session 可以包含权限生命周期与投影事件，同时继续保持隐藏和可复用。首个模型轮次或用户可见命令仍会将其物化。所选权限在 Hero 阶段持续有效，并可在原始 Session 日志中审计。

每个界面都从自己的 locale 命名空间读取中英文权限或会话日志标签。编辑器把加号和回形针归为前置操作，不改变 slot 授权或附件行为。

## Verification

Host blank-summary suite 区分 permission、用户可见命令与模型轮次。conversation 组件覆盖固定内建名称的本地化、确认文案以及“加号、附件、模式”的 DOM 次序。Session-log Header 覆盖固定中文可见与无障碍文案。组装后的 Web replay 和隔离 Supervisor candidate 演练真实插件组合。

## Related

冷 Session 验证继续采用[有界冷 blank 验证](2026-08-13-bounded-cold-blank-verification.md)记录的保守可见性方向；state-version 失效让符合条件的工件按本活动定义重新 fold。Slot 所有权继续由 [slot type-chain 实现](../architecture/2026-07-22-slot-type-chain-implementation.md)约束。
