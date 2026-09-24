# Agent Note: 宿主丢弃围栏语言标签，渲染器改从源文本读取

Status: implemented

[English](2026-09-24-genui-fence-language-comes-from-the-source.md) | 中文

## Problem

运行时切到官方 DSH 0.1.7-rc.1 之后，3080 部署里所有 `dsh-ui` 围栏都渲染成了原始 JSON 代码块。插件本身是挂载着的、客户端半边也启动了（`[genui] client active; fence-channel=dom`），所以这个故障看起来像 GenUI 的缺陷；实际上是宿主改了标记结构，而被钉住的渲染器看不见这个变化。

官方 0.1.7-rc.1 把所有 Markdown 围栏都交给新的 `CodeToolbar` 渲染。该组件只在语言可以高亮时才打印语言名：

```tsx ignore-check
<span>{supportsHighlighting(lang) ? lang : labels.codeLabel}</span>
```

`dsh-ui` 不是可高亮的语法，于是头部打印的是本地化的 `codeBlock.title`——「代码块」／"Code block"——而 0.1.6-alpha.2 打印的是 `{lang ?? ''}`。这个标签是 DOM 渲染器唯一的发现通道：`@changfenhuang/dsh-genui@0.11.0` 通过寻找文本修剪后恰好等于 `dsh-ui` 的叶子元素来发现围栏，标签一改名，它对每个围栏都视而不见。原始块仍然可见、JSON 正文仍然可读，所以这个缺陷表现为「GenUI 不工作了」，而不是标记不匹配。

## Decision

把策展的渲染器升级到 `@changfenhuang/dsh-genui@0.11.1`，并把 pin 保留在分发层，让它的每一个消费方一起移动。

0.11.1 改为从宿主公开的 chat snapshot 恢复围栏语言，而不依赖头部文本。它通过 `uiConversation` 服务绑定会话 target，遍历 assistant step 的 blocks，并按围栏的序号读取代码块自身的 `lang`：

```ts
const node = snapshot?.nodes.get(nodeKey)
if (node?.kind !== 'assistant-step') return undefined
return sourceFencesOfAssistant(node.data.blocks)[ordinal]?.lang
```

snapshot 是「模型写了什么」的权威来源，所以标签不再是宿主与渲染器之间的接口。对于没有 `registerFenceRenderer` 的宿主，DOM 通道继续作为回退——本次部署用的正是这条通道：插件报告 `fence-channel=dom`，因为官方 DSH 尚未暴露围栏注册表。

有三处事实把这个变更固定在仓库里，而不只是固定在运行中的 profile 里：

| 位置 | 事实 |
|---|---|
| `packages/bundle/plus/package.json` 里的 `dshPlus.profile.dependencies` | 每个消费方收到的、经过评审的渲染器版本 |
| `scripts/verify-plus-governance.ts` 里的 `expectedProfileDependencies` | 门禁对同一个已评审集合的副本 |
| 两个生成的 standalone manifest | npm 安装解析到的版本，以及它需要的 peer 覆盖 |

## Findings this change rests on

1. **出问题的标签是宿主标记，不是插件状态。** 部署后的 DOM 里头部显示为「代码块」，而 `supportsHighlighting` 走一张没有 `dsh-ui` 条目的别名表。旧宿主的头部会原样打印 info string，所以同一个插件在 0.1.6-alpha.2 上是正常的——回归是随运行时而来的，不是随渲染器而来的。

2. **渲染器会报告自己绑定到哪条通道。** `[genui] client active; fence-channel=registry` 与 `dom` 区分了「宿主给了我们围栏注册表」和「我们在扫描标记」。本次部署打印的是 `dom`，所以修复必须恢复不依赖标记的发现方式，而不是采用宿主尚未提供的注册表 API。

3. **升级后的渲染器会接管围栏并隐藏原始块。** 针对本次部署在无头浏览器里实测：`.md-code-block` 计算为 `display: none`，`genui-dom-fence` 容器为 781×207 且可见，`data-genui` React 根中持有 callout 的标题与正文。升级前，同一个元素就是那段原始 JSON 围栏。

4. **旧的 pin 声明了运行时无法满足的 peer。** 0.11.0 声明 `^0.1.2-rc.1 || ^0.1.5-alpha.1`，不接纳 0.1.7-rc.1，所以生成的 manifest 带着 17 条 `peerOverrides`，其唯一原因就是那个范围。0.11.1 在其范围中声明了 `^0.1.7-alpha.1`，直接满足运行时，重新生成后这 17 条随之消失。剩下的 23 条覆盖属于其它插件（`dsh-sql-workbench`、`dsh-better-sidebar`、supervisor、SSH manager、MinerU、office viewer fonts、computer-use），所以这次生成是真正的推导，而不是手工编辑的清单。

5. **一个 profile 写入锁在持有者消失后留存了下来。** profile 里有个 `package.json.lock`，它写的 PID 已经不存在，而 `withFileLock` 从不删除已存在的锁——孤儿锁的回收是运维动作。此后任何 profile 写入都会等满 120s 期限后失败。确认该 PID 已死之后删除了这把锁，并在之前先备份了 profile。

6. **这次升级无需重启就到达了运行中的服务。** `client-hmr` 会 stat 轮询每一行 graph 的客户端 bundle，并在元数据变化时重新发布，所以新安装的 bundle 在下一个请求就被发出。后续的健康检查确认了这条通路：HTTP 200、`CLIENT-VERIFY: OK`（75 个客户端模块）、以及 WebSocket 101 握手。

## Alternatives considered

**改宿主，让它重新打印 info string。** 否决：这是为了服务某一个插件的发现启发式而恢复一个装饰性标签，而且它会把标签重新变成宿主与渲染器之间的接口——而正是这一点导致了故障。

**钉住 0.11.0，再加一个补丁教它识别新标签。** 否决：上游项目已在 0.11.1 用基于源的机制修掉了这个缺陷，本地补丁只会给同一种发现逻辑再加上一份更窄的实现，并在 pin 移动时还需要退役。

**只升级运行中的 profile，不动仓库里的 pin。** 否决：分发层才拥有「经过评审的版本」，所以下一次从源码重建会重新安装 0.11.0，并悄悄把缺陷带回来。门禁的 `expectedProfileDependencies` 也会与分发层不再一致。

**同时改动 `.agents/plugins/curated.yaml` 里的 pin。** 否决：该字段并不与 profile 同步维护——MinerU 与 officecli 在两者之间本就不一致，GenUI 自己那条至今还写着 0.9.8——只改这一条会让清单看起来对一个包具有权威性，却对其余的仍然过时。把那个字段对齐是另一件事。

## Consequences

- 3080 部署上的 `dsh-ui` 围栏恢复渲染，并且是在真实浏览器里端到端验证的，而不是只检查标记。
- 渲染器的围栏发现不再依赖宿主头部文本，所以将来某个宿主版本重命名或隐藏该标签时，会退化为 snapshot 通路，而不是退化成原始代码块。
- 生成的 standalone manifest 少了 17 条 peer 覆盖，而重新生成正是其证明：`verify:standalone-manifest` 与 `verify:standalone-variants` 均通过。
- `@sparkelf/dsh-mobile-bridge@0.2.12` 仍声明 `0.1.5-rc.2` 的 peer 并在启动时持续告警。它与围栏渲染无关，不在本次变更范围内。
- profile 的安装树现在是 0.11.1，而一台从不重装依赖的机器会一直保留 0.11.0，直到它下一次安装 profile。
