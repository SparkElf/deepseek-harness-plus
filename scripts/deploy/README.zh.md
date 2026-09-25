# 部署脚本

[English](README.md) | 中文

这些脚本针对 DSH home 下的运行中部署执行。它们存放在此处作为流程的记录；部署 home 中保存的是实际执行的副本。

| 脚本 | 用途 |
|---|---|
| `dsh-plus-switch <mirror>` | 把服务的 release 切换到另一个 mirror。在触碰服务之前先校验目标，把每一步记录进 phase 文件，失败时回滚。 |
| `fix-nested-links.mjs --release <dir>` | 恢复 release 内的 `pnpm install` 重写掉的逐包依赖链接。它读取 scope 检查器自己的报告，因此两者不可能对「缺什么」产生分歧。 |
| `migrate-session-v3.mjs [--dry-run]` | 当 v4 日志已覆盖全部事件时，归档该会话被取代的 `session.v3.jsonl.zstd`。 |

## 为什么步骤顺序重要

运行中的 supervisor 会在每个进度阶段重写它的 manifest：不只是 `stop()`,`announce()` 也会调用 `writeStatus()`。因此在耗时数秒的 acceptance 步骤之前写入的 manifest，等到有东西读取它时已经是 supervisor 自己那份更旧的副本。实测：manifest 写明了新 mirror，`profile-guard accept` 运行了数秒，随后 reload 采纳的却是前一个 mirror —— 一次报告成功、实际仍在服务旧 release 的升级。

成立的顺序是 `link → accept → manifest → reload → verify`。

切换脚本在触碰单元之前还会通过 `systemd-run` 把自己重新执行一遍：若从运行时单元内的会话启动，它的 `systemctl stop` 会杀掉发起它的那个进程。

## 为什么需要链接修复器

release 会安装自己的依赖图，而那次安装会重写哪些包从 profile 解析。scope 检查会报告每个依赖不再可解析的包；修复器精确恢复这些链接。跳过它会让部署能够启动，然后每个工具调用都以 `reading 'prepare'` 失败，因为重复的模块实例给出了两个 scheduler Symbol。

## 为什么要归档 v3 日志

早于 v3→v4 格式迁移的会话，会在同一目录里保留两代文件。持久化层解析现存最高的一代，因此它读 v4 而永不重跑迁移 —— v3 文件被留了下来，带着 v4 拒绝的语法（`source.kind: "plugin"`、缺少 tool-role 消息的 tool result）。一旦某次读取碰到那些行，就会以「format v4 message requires a producer-owned source kind」失败，而该会话本身是健康的 —— 表现为一次运行失败，而不是一个陈旧文件。

`migrate-session-v3.mjs` 把这个孤儿移到一边。它是移动而非删除，并且拒绝任何「v4 日志未完整包含」的文件，因此归档里只可能出现活动日志已经复现的数据。
