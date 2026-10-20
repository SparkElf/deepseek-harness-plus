# @sparkelf/dsh-patch-image-offload-hoist-replay

[English](README.md) | 中文

本补丁让「`image/offload` 决策是按 hoist 后的图片位置记录」的会话重新可读。

`image/hoist` 是仓库外的请求期投影：它把 tool 结果里的图片移到更早的一条 user 消息上，但不改写持久化的消息本身。之后的 `image/offload` 按**投影后**的消息（也就是当次请求真正看到的那个）深度优先数图片出现的下标。这些下标描述的是「已经承载了 tool 图片的那条 carrier」，因此一旦读取器在不挂载 hoist 投影的情况下折叠同一份日志，下标就不再解析得开。

`offloadMessageImages` 把「下标解析不到」当成致命错误（`image/offload: image index 0 does not exist`），于是一份部分有效的 payload 直接中止整个折叠。用户可见的症状是会话再也打不开：

```
failed to read referenced session: invalid session surface:
image/offload: image index 0 does not exist
```

一旦发生，三条彼此独立的路径同时坏掉 —— `session-query` 的所有冷读（`listEvents`、`readSurface`、`search documents`、`traceEvent`）、sqlite 内容索引、以及 `readSession` 的回放校验。**卸载插件只会更糟**：只剩 catalog 的读取连解释这些位置的依据都没有了。

## 补丁改了什么

两层，各自针对不同的部署形态：

1. **按日志（而非按读取器）决定回放是否严格。** `offloadMessageImages` 新增 `positionsAreAuthoritative`，由投影从折叠窗口自身推导：日志里只要出现 `image/hoist` 行，位置就是投影相关的，解析不到的下标跳过、已 offload 的下标视为无操作。**没有** hoist 行的日志在任何地方折叠都一致，那里解析不到仍然是硬错误 —— 写入方 bug 该响还是会响。

2. **冷读按已挂载的投影回放。** `SessionQueryEngine` 每次调用解析 `ctx.sessions.messageProjections`，并把它串进 `eventRecords`、`currentSurfaceEvents`、`traceEvent`、`buildSessionEventSearchDocuments`、`buildSessionEventRecords` 和 `Session.create`。此前查询服务在三个折叠点上都硬编码第一方 catalog（`[imageOffloadProjection]`），而活会话存储注册的是完整挂载集合 —— 于是一个活会话和它自己的冷读会对同一份日志得出不同结论。catalog 定义仍排在最前；与 catalog 同类型的活投影会被丢弃，因为折叠本身拒绝重复归属。

第 2 层同时修掉了一类更普遍的分歧：任何插件自有投影，现在都会像它写这些行时那样作用于冷读。第 1 层则保证在完全不挂载写入插件的主机上，日志依旧可读。

## 为什么选择容忍而不是修复日志

改写已提交的会话世代不是一个选项：迁移可以新增一个以版本命名的后继，但不能移动、覆盖或删除已提交的世代。容忍一个解析不到的位置，代价是在不挂载 hoist 插件的主机上最多有一张图片未被抑制 —— 这严格优于整个会话不可读，也正是 `image/hoist` 自己面对「端点已被 compaction 移除」时已经采用的取舍。

`image/hoist` 行带有信封的 `ignorable: true`，这个标记的含义正是「不挂载该事件所属插件的读取器可以跳过该记录」。在本补丁之前，只有「跳过」是安全的；依赖那些移动的 offload 行仍然会拒绝整份日志。

## 验证

折叠部署中的酷家乐会话（`session-1f4dcf0f-c707-484a-8fb4-5f81a7fad594`，4222 条事件、56 条 hoist 行、seq 4134 处 1 条 offload 行）：

| 读取路径 | 改前（仅 catalog） | 改后 |
|---|---|---|
| `listEvents` | 抛 `image index 0 does not exist` | 4222 条记录 |
| `readSurface` | 抛错 | 844 个 current 节点 |
| `search documents` | 抛错 | 1963 篇文档 |
| `traceEvent(4134)` | 抛错 | 正常解析 |
| `Session.create` 回放 | 抛错 | 校验通过 |

挂载 hoist 投影时，原本选中的 17 个出现位置在 seq 1394 与 1846 上仍照旧回放为 offloaded，两种配置一致。`packages/compaction/compaction-image-offload`（40 个测试）与 `packages/session-query/*`（169 个测试）全部通过，其中两个新用例把「严格 / 容忍」的分界钉住。
