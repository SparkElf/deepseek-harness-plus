---
description: "可通过npm安装的DeepSeek Harness Plus profile composition及explicit official-source materializer。"
kind: "package-bundle"
---

# @sparkelf/dsh-plus

[English](README.md) | 中文

## 概述

该distribution把official `@deepseek-ai/dsh-base`及`@deepseek-ai/dsh-web-app`与selected external sidebar、Office、MinerU、mobile、market、GenUI及Supervisor packages、四个in-repository Plus capability packages及十三个independent patch packages组合起来。它只持有ordered composition、minimum compatibility metadata、dependency closure、explicit materialization及credential-free deployment lock；capability behavior和patch payloads仍属于各自package。

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

rc22 explicit apply步骤固定official revision `d347e703908d0406b7a7ef80e3a0e594d86b2215`，一次应用全部pending source payloads，配置exact npm patches，删除retired Plus-owned entries，并以`0600` mode写入`.dsh-plus/patchset.lock.json`。profile中的patched official source workspaces始终覆盖clean CLI packages。profile通过reviewed release assets保留Better Sidebar 0.18.1、SQL Workbench 0.4.0、共享vault、SSH Manager 0.6.0、API Client 0.4.2及Supervisor 0.1.3，并加入Office preview 0.2.0、GenUI 0.9.8、dshmarket 1.43.0、OfficeCLI 0.1.0、Office fonts 0.1.0及MinerU 0.1.0。version conflict、source mismatch、bundle缺失和runtime closure drift都会阻止promotion。

Official DSH提供generic file upload、durable attachment cards、model-visible readonly paths、onboarding、Workspace selection、Session export及Turn folding。Plus在首次搜索时启用official SQLite Session query provider，持久派生索引位于`$DSH_HOME/storages/session-query.sqlite`，canonical compressed JSONL仍为history source。Plus另增加原始Office文件与video的Better Sidebar preview、用于生成原始DOCX/XLSX/PPTX的OfficeCLI工具，以及无需prompt hook、直接消费official uploaded-file path的MinerU PDF工具；同时把简体中文导出界面中混用的英文`Session`替换为中文，在桌面端把会话日志操作放到Trajectory搜索框紧邻左侧，在手机上保留其Header位置，并让composer permission与model popover保持在center column内且水平边缘各留12px间距。`@changfenhuang/dsh-genui@0.9.8`已内含此前patch的streaming EChart behavior。registry-pinned Supervisor管理materialized runtime并恢复被自身restart中断的Sessions。DataOps和MinerU仅在对应endpoint environment variables存在时mount。Agent Teams仍被排除，因为official shipped profiles禁用这些private experimental packages。

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
