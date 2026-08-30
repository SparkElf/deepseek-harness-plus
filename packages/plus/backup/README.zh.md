---
description: "为file-backed DSH user data提供streamed authenticated export、validated restore及browser progress。"
kind: "package-reference"
---

# @sparkelf/dsh-plugin-backup

[English](README.md) | 中文

## 概述

该完整Host及Client plugin导出并恢复三种明确的user-data subset：全部、仅配置或仅会话。配置包含active Settings document、credentials、可选`.env`及anonymous identity；会话包含Session logs、attachments及storage-backed Workspace/projection state。Export、upload和import通过Host temporary files stream并提供bounded NDJSON progress；import会在mutation前验证versioned manifest、scope、paths及expanded byte total。

## 目录

- [使用此软件包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制和延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此软件包

Host entry需mount在`connection`、`webServer`、`settings`及`workspaceRegistry`之后，Client entry需mount在locale及Settings之后。file-backed Settings provider提供`settings.documentPath`；`maxUploadBytes`默认为2147483648 bytes。

Settings section使用三段segmented control。**全部**是配置与会话的并集；它不归档generated profiles、releases、logs、Supervisor files、cached packages或其他runtime output。**配置**只恢复配置文件，不关闭Session/Workspace storage。**会话**把`sessions`、`attachments`及`storages`一起放进Workspace storage-restore transaction恢复。Archive manifest记录scope与active Settings filename；含配置的archive在import时要求相同Settings filename。

authenticated routes为POST `/api/backup.export.prepare?scope=all|configuration|sessions`、GET/HEAD `/api/backup.export`、POST `/api/backup.upload`及POST `/api/backup.import`。每条route会在读取request data前应用Connection Host、Origin及browser-authentication policy。Browser cancellation只结算当前route，绝不会终止Harness Host。Token在十分钟后过期并且single-use，HEAD metadata inspection除外。

一旦restore开始写入，关闭page不会中断replacement。Workspace storage会在file replacement期间关闭并在completion前重新打开；Client会先释放completed progress stream reader，再由UI提供一次explicit reload。Client failure保留在Backup section可见状态，不产生browser console error。

-----

<a id="model-experience"></a>
## 模型体验

### Backup operations

#### 模型看到什么

没有内容。`@sparkelf/dsh-plugin-backup`把Backup archives、progress、failures及restored files留在Host storage和Settings UI；该package不注册model-facing tool、prompt section或Session event。

#### Token 影响

为零。Backup operations不增加model-request tokens。

#### KV Cache 影响

独立。Export、import、progress及reload不改变model request prefix。

## 已知限制和延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Overwrite without rollback**：restore会替换declared scope内的same-name files，保留archive中不存在的files，并且在mutation开始后disk write失败时不创建rollback copy。
- **只接受当前archive format**：scoped archive使用manifest version 2；pre-release version 1 archive会被拒绝，不猜测其scope。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文，点击展开</summary>

该开发备注是maintainer working context；shipped behavior、limits及rationale以以上sections、package code及linked Agent Note为准。

- [Backup Agent Note](../../../.agents/notes/proposed/architecture/2026-08-30-plus-backup-plugin.zh.md)持有archive、route、restore及progress decisions；`src/index.ts`和`src/client/BackupSection.tsx`持有current behavior。

</details>
