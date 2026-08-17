# @deepseek-ai/dsh-client-ui-settings-backup

[English](README.md) | 中文

设置页"备份"分区：设置对话框的 `backup` 页面把用户设置和数据导出为一个 zip 压缩包（浏览器下载），并从备份压缩包导入恢复。压缩包字节经仅回环的 Host 路由 `/api/backup.export`（单次令牌下载）与 `/api/backup.upload`（请求体流式落盘）流式传输；RPC 对（`settings.backupExport` / `settings.backupImport`）只携带下载 URL 与上传令牌，不携带压缩包内容。压缩包契约——清单标记、运行时生成目录排除、解压前 zip-slip 校验、同名覆盖——与其实现一起在 `dsh-host-apiproxy`；本包只渲染页面并本地化其状态。

## Model Experience

None, as the plugin renders browser settings UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- 导入会恢复 harness home 下的文件，但不会重启另行管理的桌面运行时；Web Host 对设置活体重读。
- 压缩包以 base64 经回环 RPC 传输，体积受浏览器与 Host 内存约束；运行时生成的 `profiles` 与 `supervisor` 目录导出不含、导入不恢复。
