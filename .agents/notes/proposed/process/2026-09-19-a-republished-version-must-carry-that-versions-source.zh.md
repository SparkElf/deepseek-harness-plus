# Agent Note: A republished version must carry that version's source

Status: proposed

[English](2026-09-19-a-republished-version-must-carry-that-versions-source.md) | 中文

## Problem

`@sparkelf/dsh-api-session-controller@0.1.6-alpha.2` 与 `@sparkelf/dsh-agent-presets@0.1.6-alpha.2` 在 DSH 0.1.6-alpha.2 上无法加载。两者携带的 typert 清单其 codec 缺少 alpha.2 loader 所要求的 `create()` 工厂：

```
typert-loader: @deepseek-ai/dsh-api-session-controller invocation
  "@deepseek-ai/dsh-api-session-controller#fileReferences/list" parameter codec
  must use a strict codec
```

对同一版本的两份构建实测：

| | 官方 `@deepseek-ai` | 我们的 `@sparkelf` |
|---|---|---|
| `lib/typert.host.js` | 164788 字节 | 159731 字节 |
| `create:` 出现次数 | 34 | 0 |
| `repository.url` | `github.com/deepseek-ai/deepseek-harness` | `github.com/SparkElf/deepseek-harness-plus` |

因此，遵循发行版自身 `overrides` 的部署会启动失败：override 把 `@deepseek-ai/*` 指向我们重发布的副本， 而该副本无法注册。

## Why it happened

`scripts/release/republish-patched-official.mjs` 接受 `--version`，而那次发布以 `0.1.6-alpha.2` 运行它，同时 fork 自己的 workspace 仍声明 `0.1.6-alpha.1`：

```
$ node -p "require('./packages/api/session-controller/package.json').version"
0.1.6-alpha.1
$ npm view @sparkelf/dsh-api-session-controller version
0.1.6-alpha.2
```

该标志会改写每个重发布清单的版本字段。它不会、也无法更新那些包的构建来源。版本号是对内容的声明， 因此发布产物声称自己是 alpha.2，携带的却是 alpha.1 的 typert 定义 —— 而那正是 loader 唯一校验的字段。

**发布路径中没有任何环节比对这两者。** 发布器验证打包产物与其来源 workspace 一致，这确实通过了； workspace 自身的版本从未与被发布的版本做过比对。

## Proposal

**拒绝源码并未声明的重发布版本。**

在 `package-patched-official.mjs` 中，当给出 `--version` 时，将其与源码 checkout 自身的版本比对， 不一致即失败：

```
republish-patched-official: --version 0.1.6-alpha.2 but the source declares
0.1.6-alpha.1 at packages/api/session-controller; rebase the patches onto the
alpha.2 tree first, then republish
```

该比对属于打包步骤而非发布步骤：打包正是读取源码之处，于是这道门禁也覆盖包括聚合入口 `republish-patched-official` 在内的每一个调用方。

## Findings this change rests on

1. **两份构建的差异仅出现在源码有差异之处。** 上表的大小与 `create:` 计数；`repository.url` 字段可辨认消费者拿到的是哪一份。
2. **loader 校验的是 codec，不是版本号。** `requireStrictCodec` 检查 `mode === 'strict'` 与 `typeof create === 'function'`；来自更旧源码的清单在第二项上失败。
3. **该失败是启动失败，而非降级运行。** 整个 profile 加载失败： `failed to apply loader entry typert-loader`。
4. **只有遵循 overrides 的部署会受影响。** Linux profile 停在 `0.2.0-rc.5`，其 overrides 并未生效、 拿到的是官方包，因此这个缺陷一直隐藏，直到一次全新安装让 overrides 真正生效。
5. **正是全新安装让它浮现。** Windows 部署在 `pnpm` 从头解析 overrides 之后的第一次启动就复现了它。

## Acceptance criteria

- 当 `--version` 指向源码 checkout 未声明的版本时，打包失败。
- 错误同时点名两个版本与那个不一致的 workspace。
- 源码与版本一致的发布仍然成功。

## Alternatives considered

**把补丁 rebase 到 alpha.2 的树上再重发布。** 这是当前这次发布的实际修法，也是门禁提示信息所要求的； 门禁的存在是为了让下一次发布无法跳过它。

**把打包好的 tarball 与同版本的官方包比对。** 否决作为主检查：补丁本就有权改动文件， 这种比对无法判定什么是陈旧的。版本一致才是真正成立的不变量。

**以源码自身的版本发布。** 否决：发行版的 overrides 点名了精确版本， 把同一版本以另一个号发布会让 override 指向不存在的东西。

## Risks

**门禁会拦住一次当前能通过的发布。** 在源码未变的情况下重发布该版本的修正构建是真实场景； 现在它需要先提升源码版本，而这正是重点。

**fork 的源码版本必须与其跟踪的上游保持同步。** 今天这是一步手工操作， 门禁把它的遗漏从"静默地发布坏包"变成"发布失败"。
