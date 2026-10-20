# Agent Note: 依赖投影位置的 image/offload 选择会让会话永久不可读

Status: implemented

[English](2026-10-19-image-offload-recorded-against-hoisted-positions.md) | 中文

# Agent Note: 依赖投影位置的 image/offload 选择会让会话永久不可读

## Problem

`image/offload` 把一份持久决策存成「消息内深度优先的图片**出现位置下标**」。这些下标是在**决策那次请求真正携带的消息**里数的 —— 也就是**投影后**的消息，不是持久化的那条。仓库外的 `@sparkelf/dsh-image-hoist` 插件会在请求期把 tool 结果里的图片移到更早的一条 user 消息上（`image/hoist`），因此在被 hoist 过的会话里，这些计数描述的是「已经承载了 tool 图片」的那条 carrier。

`offloadMessageImages` 把「解析不开的选择」当成致命错误：

```
image/offload: image index 0 does not exist
```

于是一份只能部分解析的 payload 直接中止整个 surface 折叠，会话从此再也读不出来。在部署中的酷家乐会话 `session-1f4dcf0f-c707-484a-8fb4-5f81a7fad594` 上实测：seq 4134 在 seq 1394 与 1846 上记录了 17 个出现位置，但这两条事件在持久日志里是纯文本 —— 图片只有跑过 hoist 投影之后才落在更早的 carrier 上。所有不挂载该投影的读取器都抛错，包括用户自己的引用读取：

```
failed to read referenced session: invalid session surface:
image/offload: image index 0 does not exist
```

三条彼此独立的路径同时坏掉，因为它们都要折叠日志：`session-query` 的所有冷读（`listEvents`、`readSurface`、`filterEvents`、`traceEvent`）、sqlite 内容索引、以及 `readSession` 的回放校验。卸载 hoist 插件只会更糟 —— 只剩 catalog 的读取器对这些位置连解释的依据都没有了。

还有第二个、更安静、但同源的缺陷：`session-query` 在三个折叠点上都硬编码 `currentSessionMessageProjections`（`[imageOffloadProjection]`），而活会话存储注册的是完整挂载集合。于是**任何**插件自有投影下，一个活会话和它自己的冷读都可能对同一份日志得出不同结论 —— 不只是这一个。

## Decision

两层，各自足以应对不同的部署形态。

**回放是否严格，由日志决定而不是由读取器决定。** `offloadMessageImages` 新增 `positionsAreAuthoritative`，由投影从折叠窗口自身推导：只要日志里出现任何 `image/hoist` 事件，位置就是投影相关的，解析不到的下标跳过、已 offload 的下标视为无操作。没有 hoist 事件的日志在任何地方折叠都一致，因此那里解析不到仍然是硬错误 —— 写入方 bug 该响还是响，不会静默少抑制。这一层保证了在**完全不挂载写入插件**的主机上会话依然可读。

**冷读按已挂载的投影回放。** `SessionQueryEngine` 每次调用解析 `ctx.sessions.messageProjections`，并把它串进 `eventRecords`、`currentSurfaceEvents`、`traceEvent`、`buildSessionEventSearchDocuments`、`buildSessionEventRecords`、`Session.create`，以及 sqlite 的 observe 路径。访问器是 `protected`，让后端能直接透传而不用重新推导。catalog 定义仍排在最前；与 catalog 同类型的活投影会被丢弃，因为折叠本身拒绝重复归属。

选择「容忍跳过」而不是「修复日志」，是因为已提交的会话世代不可改写：迁移可以新增一个以版本命名的后继，但永远不能移动、覆盖或删除某个世代。容忍的代价是在不挂载该插件的主机上最多有一张图片未被抑制 —— 这严格优于会话不可读，也正是 `image/hoist` 面对「端点已被 compaction 移除」时已经采用的取舍。`image/hoist` 行本来就带信封的 `ignorable: true`，这个标记的含义正是「不挂载该事件所属插件的读取器可以跳过该记录」；在本改动之前，「跳过」是安全的，但依赖它的 offload 行仍然会拒绝整份日志。

## Alternatives considered

**就地修复日志。** 把 17 个记录的写下标改写成持久位置，能让选择与读取器无关；但已提交的会话世代不可改写：迁移可以新增一个以版本命名的后继，但永远不能移动、覆盖或删除某个已提交世代。而且它还得重新推导出只有 hoist 投影才知道的位置。

**把 hoist 投影放进 catalog。** 让 `image/hoist` 成为第一方 catalog 定义，就能让所有 detached 读取器回放它。不作为主机制，是因为 catalog 是第一方 detached 回放面，必须保持浏览器安全、且不含插件；把仓库外插件的事件类型硬编码进 catalog，会颠倒插件系统本要维护的归属规则。把已挂载集合串进查询服务能取得同样效果而没有这层耦合，而「按日志容忍」仍然覆盖什么都不挂载的主机。

**解析不开就丢弃整条 offload 决策。** 丢掉这一行能让日志可读，但它会在每次请求上静默地让最多 17 张图片不受抑制 —— 与这条决策记录的意图正好相反。逐位置跳过则保留决策对所有仍能解析的位置的意图。

## Consequences

被 hoist 过的会话的冷读不再抛错；并且对**任何**插件自有投影，活会话与它自己的 detached 读取现在都对同一份日志得出相同结论，而不只是第一方 catalog。

完全不挂载投影的主机现在读到的会话里，tool 结果图片停在持久位置，也就是未 hoist 的形态 —— 对该主机的请求形态而言是对的，但这意味着投影视图取决于读取器的插件集合，而不是仅由日志决定。这是请求期投影的固有性质，现在两侧都已写明。

当一份选择只能部分解析时，容忍路径可能留下一张未被抑制的图片；它表现为请求略大而不是报错，而严格路径仍然能在任何没有 hoist 行的日志上抓到真正的坏选择。

`offloadMessageImages` 现在多了一个参数；`projection.ts` 里唯一的调用方从折叠窗口提供它，所以省略它的新调用方得到的是严格行为。

## Verification

折叠酷家乐日志（4222 条事件、56 条 hoist 行、seq 4134 处一条 offload 行）：

| 读取路径 | 改前（仅 catalog） | 改后 |
|---|---|---|
| `listEvents` | 抛 `image index 0 does not exist` | 4222 条记录 |
| `readSurface` | 抛错 | 844 个 current 节点 |
| 搜索文档 | 抛错 | 1963 篇文档 |
| `traceEvent(4134)` | 抛错 | 正常解析 |
| `Session.create` 回放 | 抛错 | 校验通过 |

挂载 hoist 投影时，原本选中的 17 个出现位置在 seq 1394 与 1846 上仍照旧回放为 offloaded，两种配置完全一致。`tests/projection.spec.ts` 新增两个用例把「严格 / 容忍」的分界钉住。`packages/compaction/*`、`packages/session-query/*`、`packages/core/session` 全量通过（45 个文件、1035 个测试）。

本改动在仓库外以 `@sparkelf/dsh-patch-image-offload-hoist-replay` 与 `@sparkelf/dsh-image-hoist` 0.1.5 落地；后者另外修掉了「多条 target 共用一条 carrier 时，投影只保留最后一张图片」的丢弃问题。
