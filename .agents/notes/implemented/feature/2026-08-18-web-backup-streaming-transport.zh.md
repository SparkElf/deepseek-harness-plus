# Agent Note: Web 备份流式传输取代 base64 过 RPC

Status: implemented

[English](2026-08-18-web-backup-streaming-transport.md) | 中文

## Problem

最初的 web 备份传输把 zip 压缩包以 base64 嵌进 JSON RPC 应答和请求。150 MB 的 harness home 在 Host 侧产生约 190 MB 的 base64 字符串及 JSON 信封副本，浏览器又经 `atob` 和 Blob 再复制一份，点击"导出备份压缩包"会在两端耗尽内存。

## Decision

压缩包字节不再走 JSON 线路。`settings.backupExport` 把 zip 写入 Host 临时文件并应答单次使用的 `/api/backup.export?token=…` URL；承运层经 host-only `backups` 域（`downloads` 的镜像）把文件流式作为 zip 附件响应。导入经仅回环的 exact 路由 `/api/backup.upload`（2 GiB 上限）把所选文件流式落盘，`settings.backupImport` 消费上传令牌、校验并恢复。两条路由与设置面其余部分一样钉死回环。本决策取代 [2026-08-18-web-settings-backup](2026-08-18-web-settings-backup.md) 中的 base64 选择；压缩包契约（清单标记、`profiles`/`supervisor` 排除、改动前 zip-slip 校验、同名覆盖）不变。

## Alternatives considered

**保留 base64 并提高请求体上限。** 拒绝：内存翻倍源于两端的编码本身，而非上限。

**分块 RPC 传输。** 拒绝：webserver 的 exact 路由注册加 node 流式能以更少协议提供相同性质。

## Consequences

- Host 内存峰值为单个 zip 缓冲；浏览器不再以字符串持有压缩包。
- 令牌单次使用、十分钟过期；临时目录在消费、过期和恢复完成时清扫。

## Verification

- `apps/web/tests/settings-backup.e2e.ts` 驱动流式下载（对令牌 URL 的 Playwright download 事件）与流式上传（文件输入 POST 到上传路由），压缩包内容与恢复断言不变。
- `packages/host/apiproxy/tests/backup.spec.ts` 覆盖字节缓冲上的 zip 核心。
