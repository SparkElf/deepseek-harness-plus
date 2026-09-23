# Agent Note: HTTP 200 does not prove a deployment works

Status: proposed

[English](2026-09-19-http-200-does-not-prove-a-deployment-works.md) | 中文

## Problem

在本机上，生产部署的每一条消息都失败：

```
本轮运行失败  Cannot read properties of undefined (reading 'prepare')  UNKNOWN
```

回合根本没有跑起来。每一次工具调用都失败，对每个会话都是如此，与发送的内容无关。

**当时所有可用的检查都是绿灯。** 页面能加载，客户端的 74 个模块全部解析成功，WebSocket 以 101 完成升级，就绪行也打印了。一个止步于其中任何一项的验证，都会在工具完全无法运行的情况下宣布该部署健康。

## Why it happened

一次工具调用要穿过两个模块加载器，而两者必须持有**同一个**模块实例，因为调度器是以模块级 Symbol 发布的：

```js
// packages/core/tools
const TOOL_RUNTIME_SCHEDULER = Symbol('@deepseek-ai/dsh-tools.scheduler')

// packages/core/agent-loop
const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)
```

发布树里的 `agent-loop` 从发布树解析 `@deepseek-ai/dsh-tools`；profile 的 loader 从 `profile/node_modules` 解析注册表实现。当两边都持有该包时 —— 即 profile 作用域里放的是**实体目录**而不是链接 —— 进程里就有了两份实例、两个 Symbol，于是查找返回 `undefined`。

对两份 profile 的实测：

| | 链接 | 实体目录 |
|---|---|---|
| 已知良好 | 305 | **0** |
| 出问题 | 296 | **23** |

一次源码同步把 11 个发布包的 `node_modules` 从发布树里搬了出来，放进 profile 作用域的实体目录中。修复它需要两半：把实体目录换回链接，**并且**把嵌套的 `node_modules` 放回发布包内，因为一个成为解析主体却没有自己依赖的发布包会改报 `Cannot find package 'compression'`。

## Proposal

**验证要问一次工具调用需要什么，而不是一个页面需要什么。**

`check-module-identity.mjs` 从两侧各解析同一个两边都携带的包，并比对结果：

```
release side: .../packages/core/tools/package.json
profile side: .../packages/core/tools/package.json
RESULT: ok - one module instance for @deepseek-ai/dsh-tools
```

当 profile 作用域在发布树本就提供某包之处放了实体目录时，这两行就会不同，检查以退出码 1 结束，并给出调用方原本只能从用户那里看到的提示。它现在是 `dsh-verify` 的一部分，因此只要工具派发是坏的，任何验证都不会通过。

下面这些层次都保留；各自回答不同的问题，而这一层回答的是它们都没有问的那个：

| 层次 | 问题 |
|---|---|
| 就绪行 | 进程起来了吗 |
| `verify-client.mjs` | 客户端的模块解析得了吗 |
| `ws-check.mjs` | 传输层升级了吗 |
| `check-profile-scope.mjs` | profile 作用域是否遮蔽了发布树 |
| **`check-module-identity.mjs`** | **一次工具调用能否找到唯一的那个 Symbol** |

## Findings this change rests on

1. **该故障对 HTTP 不可见。** 状态码 200、完整的客户端产物、101 升级全部成立，而每一次工具调用都在失败。
2. **Symbol 是模块作用域的。** `Symbol('@deepseek-ai/dsh-tools.scheduler')` 对每个模块实例都是新对象，因此两份实例永不相等，即便描述文字相同。
3. **作用域的内容就是信号。** 健康的 profile 作用域只有链接：出问题的那份带着 23 个实体目录，而良好的是 0。
4. **修复有两半。** 只换成链接，会让发布包失去自己的依赖。
5. **该检查能检出人造故障。** 把一个包以实体目录形式拷进 profile 作用域，它即报失败并以退出码 1 结束。

## Acceptance criteria

- 当两个解析器对同一个包给出不同答案时，验证失败。
- 当某部署的工具调用确实可用时，验证通过。
- 失败信息点名该包、两条解析路径与修复命令。
- 某一侧缺少该包时报 unknown 而非失败，使该检查永不因部署布局本就不同而阻拦它。

## Alternatives considered

**驱动一次真实回合并断言其完成。** 这是最强证据，也是确认修复的方式，但它需要凭据与一次模型往返。身份检查是确定性的、离线的，且快到可以在每次重启前运行；真实回合属于演练，而不属于闸门。

**把 profile 作用域与一份记录下来的链接清单比对。** 否决：它在每一次合法改动上都会失效，而且分不清"缺了链接"与"包被搬走了"。

**依赖 `check-profile-scope.mjs`。** 保留，它回答的是相邻的问题 —— 作用域是否遮蔽了发布树。它在某个包解析到两处时仍报告 profile 健康，因此它是补充而非替代。

## Risks

**一个探针包代表了全部。** `@deepseek-ai/dsh-tools` 是那个 Symbol 跨进程的包，这使它成为合适的探针；仅发生在另一个包上的分歧不会被抓到。

**检查可以是对的，而部署可以是错的。** 它排除的是工具调用失败的一个特定原因，而不是所有原因。
