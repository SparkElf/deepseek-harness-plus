# Agent Note: Plus 挂载 Exa 搜索提供方

Status: implemented

[English](2026-11-16-plus-mounts-exa-search-provider.md) | 中文

## Problem

Plus 发行版可以挂载 `@deepseek-ai/dsh-web-search-exa`，但没有部署得到可用的 Exa 搜索路径。该包只被声明为发行版依赖，供安装时的 capability interview 使用，因此 `dsh-plus apply` 从不把它写入 profile 的依赖表，team 与 intranet-team edition 也都没有把它列入要安装的包。intranet-team edition 还把它写进 `omit`，投影会把该名字变成指向 `@sparkelf/dsh-omitted` 的 pnpm override；镜像即使删掉自己的 omission 断言，装上的仍是不声明任何东西的占位包。bundle patch 也没有挂载 provider 行，并让 `web.searchProvider` 停在 official `deepseek-search-api` 默认值，所以即使包已安装也永远不会被选中。

manifest 携带的版本 `0.1.6-alpha.1` 属于上一个 runtime 世代。该包的 npm `latest` tag 更旧（`0.0.1-rc.1`），其 peer 声明了 0.2.2 runtime 已替换掉的 `@deepseek-ai/dsh-environment` 与 `@deepseek-ai/dsh-invariants`；使用它会让行无法解析自己的 import。`next` tag 携带 `0.2.2-rc.1`，是最新已发布版本。它的 `@deepseek-ai/dsh-web` 与 `@deepseek-ai/dsh-launch-environment` exact peer 指向 `0.2.2-rc.1`，因此 app-boot preflight 会拿它们与 `0.2.2-rc.2` runtime 比较，并在 import 前禁用该行。

## Decision

发行版把 Exa 作为目标 runtime 的默认 provider 来拥有：

- `dshPlus.profile.dependencies` 把 `@deepseek-ai/dsh-web-search-exa` 固定到 `0.2.2-rc.1`（最新已发布版本），使 `dsh-plus apply` 与 `dsh-plus install` 把它写进 profile manifest。
- `dshPlus.profile.compatibility` 声明 `@deepseek-ai/dsh-web-search-exa@0.2.2-rc.1`，每次 profile materialization 都会把该授予合并进 `compatibility.json`，并写入声明的 runtime `0.2.2-rc.2`。该授予使用 app-boot preflight 自己的 exact-version 机制；替代方案是 upstream build 并未发布的 peer range。
- `team` 与 `intranet-team` edition 在 `packages` 中列出该包，`intranet-team.omit` 不再包含它，因此没有 edition 会替换成 omission 占位包。
- `cordis.patch.yml` 插入 `web-search-exa` 行，并用 `process.env.EXA_API_KEY ? 'exa' : 'deepseek-search-api'` 覆盖 `web.searchProvider`。该行重述 `fetchProvider: http`，因为 patch 会替换行的整个 config 对象。
- 安装时的 capability interview 保留 Exa 问题与 `EXA_API_KEY` 提示，但答案只写部署 env 文件。在那里同时写行会产生第二个同 id 的 loader entry，两次激活会注册同一个 `exa` provider id。

provider 无条件挂载。插件在 key 为空时报告自己不可用，因此没有 `EXA_API_KEY` 的部署继续使用 official provider，该行没有 model-visible 影响。`writeProfileCompatibility` 把授予合并进已有的 `compatibility.json` 而不是替换它，因为同一文件也可能持有部署为其他插件添加的授予。

## Alternatives considered

**使用 `latest` tag（`0.0.1-rc.1`）。** 拒绝，因为它的 peer 指向 0.2.2 runtime 已不再发布的包；行会 import 失败，capability 一装即死。

**保留 capability interview 作为唯一挂载路径。** 拒绝，因为 `dsh-plus apply` 从 `dshPlus.profile.dependencies` 和 editions 组合 profile，而不是从 interview；镜像构建也从不运行 interview。

**无条件固定 `web.searchProvider: exa`。** 拒绝，因为没有 key 的部署将完全没有可用搜索 provider；配置必须回退到 official provider。

**让 bundle 行按 `EXA_API_KEY` 条件挂载。** 拒绝，因为行仍需要稳定 id，capability 层的行仍会冲突；一个惰性 provider 行更简单，安装包的代价仅限它自己的代码。

## Consequences

`team` 与 `intranet-team` profile 会安装 Exa 包，intranet-team profile 不再把它改写成 `@sparkelf/dsh-omitted`。`sharedOfficials` 还会把 `dshPlus.profile.dependencies` 中每个 `@deepseek-ai/dsh*` 带进不挂载 Plus patch layer 的 edition，因此这些 profile 会安装该包但不挂载行。launch environment 中有 `EXA_API_KEY` 的部署会把 `web_search` 路由到 Exa；没有的继续使用 `deepseek-search-api`。capability record 与 `dsh-plus capabilities` 报告从 env 文件读取 Exa，因为 profile 行不再写入用户层。

## Verification

`vitest run packages/bundle/plus/tests` 通过 9 个文件中的 69 个测试，包括 capability 层新的 Exa 不写行断言、删除 legacy 行且不重新添加的编辑路径，以及 compatibility 文件的合并行为。`pnpm run verify:plus-governance` 接受新的 profile 依赖、compatibility 授予、edition package 列表以及 patch 行的所有权。发布门禁打包 tarball，`verify-packed-install` 安装它；发布后的 tarball `package.json` 与 `cordis.patch.yml` 携带该依赖、`intranet-team.packages` 成员资格、不在 `omit` 中、provider 行以及 `EXA_API_KEY` 选择器。materialize 后的 profile 携带 `compatibility.json`，把 `@deepseek-ai/dsh-web-search-exa@0.2.2-rc.1` 授予到 `0.2.2-rc.2`。