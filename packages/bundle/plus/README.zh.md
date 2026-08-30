---
description: "可通过npm安装的DeepSeek Harness Plus profile composition及explicit official-source materializer。"
kind: "package-bundle"
---

# @sparkelf/dsh-plus

[English](README.md) | 中文

## 概述

该distribution把official `@deepseek-ai/dsh-base`及`@deepseek-ai/dsh-web-app`与selected external sidebar、mobile bridge、plugin market、GenUI package、五个完整Plus capability packages及十一个independent patch packages组合起来。它只持有ordered composition、minimum compatibility metadata、dependency closure、explicit materialization及credential-free deployment lock；capability behavior和patch payloads仍属于各自package。

## 目录

- [使用此软件包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制和延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此软件包

无需Desktop或tray即可安装并materialize Plus：

```bash
dsh plugin --profile plus add @sparkelf/dsh-plus
dsh plugin --profile plus exec dsh-plus apply --dsh-root /path/to/official-dsh
dsh --profile plus
```

explicit apply步骤要求official revision `cd5ef8148158c3a752a658978873241fdf8e2bbc`，把每个selected runtime package materialize为profile-direct dependency，一次应用全部pending source payloads，配置exact npm patches，删除retired Plus-owned entries，并以`0600` mode写入`.dsh-plus/patchset.lock.json`。它在profile root安装`dsh-better-sidebar@0.17.1`，只显式允许其`node-pty` native build，并把profile的`@deepseek-ai` scope链接到`apps/cli/node_modules/@deepseek-ai`中的exact official dsh CLI dependency tree。version conflict和source mismatch会在profile installation或source mutation前失败。该package没有install lifecycle script。

Official DSH提供onboarding、Workspace selection、Session export、Turn folding及base image path。Plus使用official client profile构建该source，把附件选择器保持在输入框指令按钮正右侧，并把简体中文会话导出界面中混用的英文`Session`替换为中文。External `@changfenhuang/dsh-genui` bundle拥有generated UI，包括模型以`dsh-ui`输出的inline interactive charts。Temporary GenUI streaming EChart patch只target `0.9.6`；[upstream PR #87](https://github.com/omdsh-dev/dsh-genui/pull/87)进入npm且真实inline-chart path通过后退役。DataOps和Document Attachments仅在对应endpoint environment variables存在时mount。Agent Teams被排除，因为official packages属于private experimental workspaces且shipped profiles会禁用它们。

Plus显式选择`browserAuthentication: disabled`：其Web URL保持clean，无需process-token exchange或browser cookie即可打开，同时Connection仍执行official Host/Origin trust fence。因此所有能访问accepted authority的进程都能使用包含Shell、files与Sessions在内的完整Host API。official `web` profile保留upstream `required` default；只有Plus composition选择关闭。

-----

<a id="model-experience"></a>
## 模型体验

### Profile composition

#### 模型看到什么

没有direct内容。`@sparkelf/dsh-plus`不注册tool、prompt section、model-facing Session event或provider content；每个selected capability持有自己的model-visible behavior。

#### Token 影响

自身为零。Token use只来自profile选择的capability和official packages。

#### KV Cache 影响

自身独立。仅当selected package贡献或移除model-visible content时，该profile才会改变request prefix。

## 已知限制和延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Exact source target**：source payloads只应用于recorded official revision；其他source tree会明确失败，distribution不提供accepted-fork或fuzzy-apply fallback。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文，点击展开</summary>

该开发备注是maintainer working context；shipped behavior、limits及rationale以以上sections、package code及linked Agent Note为准。

- [Distribution Agent Note](../../../.agents/notes/proposed/architecture/2026-08-29-ranged-plus-patchset-distribution.zh.md)持有package forms、inventory、materialization及deletion rules；`src/apply.ts`和`cordis.patch.yml`持有executable profile behavior。

</details>
