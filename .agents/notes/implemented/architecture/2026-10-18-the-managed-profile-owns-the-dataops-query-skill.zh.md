# Agent Note：managed profile 拥有 DataOps 问数技能

Status: implemented

[English](2026-10-18-the-managed-profile-owns-the-dataops-query-skill.md) | 中文

## Problem

DataOps 问数技能原先装在 `@sparkelf/dsh-plugin-dataops` 里。该包已不再被组装：DataOps 迁到 managed
workspace profile（其伴随包挂载 `@sparkelf/dsh-dataops-managed`）时，它退出了 profile bundles。这次移除是有意的 —— DataOps 工具跨越独立信任边界，而 standalone profile 拥有自己的 `DSH_HOME`、没有 DataOps 身份可承载。

没有任何机制强制后来的贡献者注意到这件事。该包仍留在 workspace glob 里，仍有 `tsdown` 入口、
`tsconfig.base.json` 路径映射、`docs/config-catalog` 章节和两处 `slot-catalog` 条目，所以它读起来
仍是在用的包。因此加进它的技能会在每次发布时构建并发布，却到不了任何 catalog。用户问数据问题时拿不到
指引，面板只显示确实能解析的那个 bundled 技能。

## Decision

managed 集成拥有该技能，因为它是部署 profile 真正挂载的 DataOps 插件，而数据问答正是它自己的主题。
`dsh-dataops-managed` 通过它本来就注入的 `skills` 服务声明 `dataops-query`：为 catalog 提供描述而不读正文，
并在需要时从包内提供正文。`files` 携带该文档，使它与 `lib/` 一起进入 tarball。

`packages/plus/dataops` 已移除。能力所有者是一个包：保留一个仍会构建却无人组装的无用层，正是技能落到无人
组装之处的成因。

## Verification

- `pnpm --filter @sparkelf/dsh-dataops-managed run build` 成功，且 `lib/index.js` 含该注册。
- `npm pack --dry-run` 在 tarball 中列出 `skills/dataops-query/SKILL.md`（3.1 kB）。
- 新增测试激活插件，断言它恰好注册一个 provider，且该 provider 的文档可从包内读取。
- `gen-config-catalog --check` 与 `gen-client-catalog --check` 干净；`verify-md-links` 解析全部相对交叉链接。

## Consequences

部署的 DataOps 工作区现在会在 bundled 集合旁列出问数技能，其指引无需调用工具即可到达模型。技能随集成一起移动：
任何挂载 `dsh-dataops-managed` 的 profile 都携带它，否则不携带。

移除操作同时去掉客户端 `DataOpsSection` 与 `DataOpsExpiryModal` 注册。没有部署的 profile 挂载过它们，
所以没有用户可见界面变化；`slot-catalog` 重新生成后不再含这些条目，约定收窄到实际发布的内容。

`@sparkelf/dsh-plugin-dataops` 不再是 workspace 包，因此 `tsconfig` 路径映射、profile fixture 列表与
lockfile 条目都已移除。今后属于 DataOps 的能力进入 managed 包，那才是部署 profile 组装的东西。

## Alternatives considered

**把该包重新加回 profile bundles。** 这会让技能回到原处，但推翻了移除它时的信任边界决定：standalone
profile 拥有自己的 `DSH_HOME`、没有 DataOps 身份，在那里挂载插件等于组装一个该 profile 用不了的节点。

**把技能发布成独立包。** 纯技能包不需要 Host 或 Client 半边，但它仍需要 profile 来挂载，而 managed 集成
已经是那个挂载点。它还会把一个能力拆到两条发布线，运行时没有收益。

**保留该包并在 README 标注未使用。** 构建与路径映射会继续发出同样的错误信号 —— 正是它让技能落在了那里；
删除该包才消除这个陷阱。

## Recorded facts

- `activation.test.ts` 有两个用例在本改动之前就在 `master` 上失败：它们期望四个 settings 路由，而插件
  把 `/integrations/dataops/tool-timeout` 注册为第五个。该失败与技能无关，保持原样。
- `docs/config-catalog.zh.md` 已在三处与英文源漂移（`ui-skill-center` 缺 `translationRoot`、
  `permission-presets` 在源写 `allow` 处写 `never`、`user-approval` 缺 `'allow'` 策略）。重新生成英文侧
  暴露出这些差异；两侧现已一致。
