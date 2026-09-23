# Agent Note: A mirror's client brand comes from the build profile, not the checkout

Status: proposed

[English](2026-09-18-the-client-brand-is-a-build-input.md) | 中文

## Problem

为 dsh 0.1.6-alpha.2 构建的镜像，其侧边栏品牌显示为「DSH 本地构建」，而上一个镜像显示的是「deepseek HARNESS」。Web 客户端能应答，全部补丁都在，插件列表也完整；只有品牌是错的。

品牌不是在运行时从检出里读的，它是被编译进去的。

## Why it happened

**有两条命令能构建客户端，而只有一条会设置品牌。**

```
scripts/client-build-environment.ts
  OFFICIAL_CLIENT_BUILD_ENVIRONMENT = {
    DSH_CLIENT_BUILD_PROFILE: 'official',
    DSH_CLIENT_TITLE: 'DeepSeek Harness',
  }

scripts/build.ts
  const profile = values.profile ?? process.env[CLIENT_BUILD_PROFILE_SELECTOR]
  const clientEnvironment = resolveClientBuildEnvironment(repositoryEnvironment, profile)
```

`pnpm run build --profile official` 会走到那次注入。`pnpm run build:web`（即 `pnpm --filter @deepseek-ai/dsh-web-frontend run build`）不会 —— 它直接跑 Vite。

**没有它，品牌插件会静默失效。** `packages/client/ui-brand-official/src/client/index.ts` 开头是：

```ts
if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'official') return
```

不注册侧边栏品牌槽位并不是错误。侧边栏转而渲染 locale 回退项 `brand.localBuild`，中文是「DSH 本地构建」，英文是「DSH Local Build」。

**我跑那个 filter 是因为我只在建一个部件。** 镜像在一次仅客户端重建之后需要它的 Web bundle，而 `build:web` 正是为此命名的命令。它产出一个能工作的客户端；它产出的不是官方客户端。

## Proposal

**用一个脚本构建镜像：它跑官方 profile，并验证结果。**

`/root/.dsh/dsh-plus-build <mirror-path>` 依次执行：

1. `pnpm install --no-frozen-lockfile`，跑两次。
2. `pnpm run build --profile official`。
3. 三项检查，任一失败即以非零退出：
   - `.dsh-build/client-build-environment.json` 存在 —— 它的缺席正是官方 profile 没跑过的证据。
   - 该记录里的 `DSH_CLIENT_BUILD_PROFILE` 是 `official`。
   - 每个声明了依赖的 workspace 都有 `node_modules` 目录。

## Findings this change rests on

1. **缺失的记录就是线索。** plus-rc29 带有 `.dsh-build/client-build-environment.json`，其中 `DSH_CLIENT_BUILD_PROFILE: official`；用 `build:web` 构建的 plus-rc30 没有这个文件。
2. **产物数量不同。** `build:web` 记录 240 个客户端产物；`build --profile official` 记录 248 个以及「4 public value(s)」。
3. **那个守卫是静默 return。** 变量缺席时 `ui-brand-official` 直接返回而不抛错，因此构建错误的客户端与正确构建的客户端无从区分，只能靠品牌文本辨认。
4. **回退文案由 locale 拥有。** `packages/client/locale/src/locales/zh.ts` 定义 `'brand.localBuild': 'DSH 本地构建'`，正是构建错误的镜像渲染出的字符串。
5. **补丁新增依赖时安装必须跑两次。** 第二次会为补丁追加到清单里的依赖创建 workspace 内链接。实测：只装一次会让 `packages/experimental/agent-team/node_modules` 缺失，Agent Teams 插件随后以 `ERR_MODULE_NOT_FOUND` 失败（找不到 `@deepseek-ai/schemastery`）。

## Acceptance criteria

- 镜像由 `dsh-plus-build` 构建，绝不用包 filter。
- 当构建记录里的 `DSH_CLIENT_BUILD_PROFILE` 不是 `official` 时，构建失败。
- 当某个声明了依赖的 workspace 没有链接目录时，构建失败。
- 被提升的镜像，其侧边栏品牌读作「deepseek HARNESS」，并在切换端口之前检查。

## Alternatives considered

**在 `build:web` 外面手工设 `DSH_CLIENT_BUILD_PROFILE=official`。** 否决：它复制了构建脚本自己拥有的注入，而下一次仅客户端重建又得再记得一次。

**在 bundle 里检查渲染出的字符串。** 作为主要检查否决：品牌经组件渲染而非字面量，因此构建记录才是可靠信号。渲染出的品牌留作被提升端口上的最终验收检查。

**只重建客户端。** 否决：记录由完整构建写入，而仅客户端重建会让它描述一套与被服务的那套不同的产物。

## Risks

**该脚本比它取代的 filter 慢。** 它跑完整构建，这正是要点，且耗时以分钟计而非秒计。

**依赖检查会遍历每一份 workspace 清单。** 它花几秒，且必须针对被提升的那个镜像运行。

**若跳过检查，品牌回归仍可能上线。** 检查读的是构建记录，因此由别的路径构建的镜像会带着「无记录」到达端口而未经校验；让提升脚本调用这个脚本才是约束所在。
