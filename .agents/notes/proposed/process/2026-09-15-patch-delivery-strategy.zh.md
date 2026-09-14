# Agent Note：每个声明的补丁都能送达 registry 安装

Status: proposed

[English](2026-09-15-patch-delivery-strategy.md) | 中文

## Problem

Plus 发行版声明了十二个针对官方 DSH 源码的补丁，以及一个针对第三方 npm 包的补丁。`dsh-plus apply` 两类都能应用，因为它需要 `--dsh-root` —— 一份完整官方 checkout，它随后会重建。而 registry 安装没有这样的 checkout：`dsh-plus start` 从已发布包创建 profile，只能应用 npm 目标补丁。

在没有任何补丁对这类用户生效时，这种不对称不可见；加入 npm 目标路径让一个补丁生效，同时留下十二个失效，这才让一个已修复的缺陷（侧栏媒体路由）到达消费方，而一个 preset 缺陷没有。

实测得到的事实：

- 官方 npm 包发布 `lib/`（打包产物）、`lib/types/` 及其 README；**它不发布 `src/`**。
- `@deepseek-ai/dsh-agent-presets` 是例外：它原样发布 `presets/`。
- 重写 source 补丁的路径前缀并应用到已发布包，**只在目标是不生成的数据**（`yml`、`css`、`json`、`html`、`md`）时才成功。
- 受影响的二十个包中有十九个不发布 `src/`，因此 TypeScript 改动无法在不手工编辑 bundle 的情况下表达为 npm 补丁。

一个需要下载并构建官方源码的补丁，无法送达安装了包的普通用户。保留它，等于发行版作出了它无法兑现的承诺。

## Proposal

按每个补丁实际改动的内容分类，并用能到达 registry 安装的最廉价机制交付。当更廉价的机制可以承载它时，退休该补丁。

### 四种交付机制，从最廉价开始

1. **Profile 配置** —— `cordis.patch.yml` 已支持按 id 定向的 `config` 覆盖、`disabled` 和 `insert` 行。只改插件配置、禁用一行或新增一行的补丁，完全不需要文件补丁。这是首选机制，因为它在上游每次升级后都无需改动。
2. **我们自己的插件** —— 改变某个包行为的补丁，可以变成一个提供相同行为的插件，通过 profile 的 `insert` 或 `disabled` 对替换官方行来挂载。`@sparkelf/dsh-plugin-subagent-settings` 是可用先例：它通过 preset 自身的行列表替换了 `@deepseek-ai/dsh-tool-subagent`，而不是给该包打补丁。
3. **针对已发布数据的 npm 目标补丁** —— 原样随包发布的 `presets/`、`package.json`、CSS 或 locale 文件可以直接打补丁，正如 `better-sidebar-media-path` 所证明。便宜，但仍是对上游内容的 fork。
4. **Source 补丁** —— 只用于无法用上述方式表达的改动。因为 registry 安装无法应用它，**source 补丁不是可交付物**；它要么被转换，要么该能力从 registry 发行版中移除。

### 逐个补丁的分类

| Patch | 改动 | 机制 | 工作量 |
|---|---|---|---|
| subagent-settings-presets | 3 个 `presets/*.cordis.yml` | **npm 补丁**（已实证 `git apply --check` 通过） | 无 —— 重写路径前缀 |
| session-export-chinese | 1 个 `locales.ts` | **我们的插件**，或发布后的 locale 数据 | 小 |
| browser-auth-mode | 3 个 `connection/src/*.ts` | **profile 配置**（该模式本就是配置选择）或插件 | 小 |
| legacy-code-preset | `session-controller`、`ui-agent-preset` | 若映射是数据则用 **profile 配置** | 中 |
| ptc-mcp-schema-types | `core/tools` schema 类型 | **我们的插件**（schema 类型提供者） | 中 |
| responses-reasoning-status | `llm-pi-ai` adapter | **我们的插件**（provider adapter） | 大 |
| officecli-deliverables | `ui-deliverables` 的一个函数 | **我们的插件**，注册输出投影 | 中 |
| workspace-storage-restore | `workspace` 的一个函数 | **我们的插件**，或先推上游 | 中 |
| mobile-journal-generation | `api-gateway` 客户端流 | **我们的插件** | 中 |
| composer-popover-boundaries | `ui-layout`、`ui-primitives`、`ui-conversation` | **我们的插件**（布局/弹层） | 大 |
| session-log-trajectory-toolbar | `ui-trajectory`、`session-log-export` | **我们的插件**（工具栏贡献） | 大 |
| web-base-path | `apps/web`、`host/webserver`、`frontend-static` | **插件对** 或构建期前端变体 | 大 |

### 工作顺序

1. **先转换那个已验证可 npm 化的补丁。** `subagent-settings-presets` 让每个 registry 安装都能建立会话；它是一次路径重写加一条治理登记。
2. **转换 profile 配置可以承载的补丁。** 每一次移除都删掉一个 fork，且行为不变。
3. **其余逐个转换为插件，每个一个 PR。**
4. **当没有补丁再使用 source 机制时，从 Plus 发行版中删除该机制**，使发行版无法再静默声明其消费方收不到的补丁。为 Desktop 安装包保留 `dsh-plus apply --dsh-root`，它有那份 checkout。

## Findings this change rests on

在真实发布上实测，而非假设：

1. **官方包不发布 `src/`。** `@deepseek-ai/dsh-client-connection@0.1.5-rc.2` 只带 `lib/`、`lib/types/` 和 README。因此在 registry 安装中，TypeScript source 补丁无处落地。
2. **`@deepseek-ai/dsh-agent-presets` 是例外**：它原样发布 `presets/`。重写 source 补丁的路径前缀后应用到该包，`git apply --check` **通过**；同样的重写应用到 `dsh-client-ui-deliverables` 则失败，因为该文件没有发布。。
3. **构建后的代码 import 官方 specifier。** `@sparkelf/dsh-agent-presets` 的 `lib/index.js` 含 `from '@deepseek-ai/dsh-tools'`。Node 按名字解析 import，因此**安装位置必须保留官方名**；一个重命名了依赖的包清单会指向代码从不请求的名字。
4. **`overrides` 按名字替换，而非按清单条目。** 使用 `"@deepseek-ai/dsh-tools": "npm:@sparkelf/dsh-tools@x"` 时，pnpm 把我们的构建装到 `node_modules/@deepseek-ai/dsh-tools`，正是 import 需要的路径。已端到端验证：消费方通过官方 specifier 打印出了我们补丁的标记。
5. **`overrides` 属于 `pnpm-workspace.yaml`，不是 `package.json`。** pnpm 10 移动了它。放在 `package.json` 中会被静默忽略 —— 第一次尝试正是如此，结果解析到了官方包。
6. **npm 的 `overrides` 与直接依赖同名会报 `EOVERRIDE`。** 因此同时出现在清单依赖中的那个包（`dsh-web-app`）走依赖别名，其余十九个走 overrides。
7. **被补丁的集合恰好是二十个包。** 它们构成闭合依赖图：`dsh-web-app` 依赖其中十五个，`api-session-controller` 四个，`host-frontend-static` 两个，`agent-presets` 一个。一起发布才能互相解析；部分发布会在安装时失败，因为某个依赖指向了不存在的包。
8. **官方 registry 不在既有名字下提供第二个包**，因此重新发布必须改名到我们的 scope。改名只作用于包本身：依赖与 import 保持官方名，由消费方的 overrides 建立映射。

## Acceptance criteria

- 发行版声明的每个补丁都能被 registry 安装应用，否则发行版不声明它。
- 全新安装上 `dsh-plus start` 能建立会话：随包发布的 preset 挂载成功。
- 只改配置的补丁不留下文件补丁。
- 在仍声明任何 `dsh-source` variant 时，从 Plus 发行版移除 source 补丁交付会让 `verify-plus-governance` 失败。

## Alternatives considered

- **让 `dsh-plus start` 下载并构建官方源码。** 否决：它让 registry 安装付出完整 checkout、工具链和数分钟构建的代价，之后才能建立会话。安装了包的用户应当从该包得到可用产品。
- **以我们的 scope 发布那二十个官方包的预构建补丁副本。** **采用。** 上游每次发布都需要重建二十个包，但这次发布本身就是一次构建：`dsh-plus apply` 产出已应用补丁的 checkout，`build:official` 编译它，因此产物在任何消费方索取之前就已存在。另一种做法——让用户下载同一份源码并构建——把成本从一次发布转移到每一次安装，而 registry 安装在没有工具链时根本付不起。重建是自动化的，所以每次上游升级的成本是一次工作流运行，而非手工。
- **仍在我们 scope 下重建，但只重建补丁触及的包。** 这正是本方案采用的：约两百个 workspace 中的二十个。其余 workspace 保留官方包，通过 `overrides` 达成。
- **直接给打包后的 `lib/` 产物打补丁。** 否决：产物被压缩、合并了源码，且每次构建形状都会变。针对它的补丁在上游下次发布时就会失败，也无法与其来源源码对照审阅。
- **从 registry 安装中移除受影响的能力。** 作为一刀切答案否决：那会为了简化 registry 路径而夺走 Desktop 用户的可用功能。当某个能力不值得做成插件时，它仍是逐个补丁的正确答案。
- **保留 source 补丁并说明它们需要 Desktop。** 否决：发行版为每一种安装声明了它们，因此这个缺口是声明本身的缺陷，而不是需要解释的限制。

## Risks

- **替换官方行的插件可能与官方实现漂移。** 替代品必须跟踪它所实现的接口；挂载它的 profile 补丁让这次替换在一个文件里可见。
- **插件转换是逐个补丁的工作。** 十二次转换不是一次改动；每一次都需要针对真实安装的独立验证。
- **有些能力可能难以转换。** `web-base-path` 触及被服务的前端，那是构建产物；若无法变成插件对，该能力就保持 Desktop 专属，且发行版必须说明这一点。
- **每次上游升级都要重建并重新发布二十个包。** 该步骤由 `package-patched-official.mjs` 和 `publish-patched-official.mjs` 自动化，但它仍是一次发布操作，而不是导入即可。

## Consequences

- **registry 发行版不再声明它送不到的东西。** `dshPlus.patchPackages` 中的一个补丁成为"每次安装都会应用它"的承诺。
- **长期看补丁更少、插件更多。** 插件有版本、可测试、独立于官方 revision；补丁三者皆无。
- **Desktop 安装包保留 source 补丁路径**，用于确实需要官方树的那些能力，且该路径由其自身的发布持续检验。
