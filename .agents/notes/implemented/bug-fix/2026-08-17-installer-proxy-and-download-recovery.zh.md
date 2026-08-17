# Agent Note: 安装器代理与下载恢复

Status: implemented

[English](2026-08-17-installer-proxy-and-download-recovery.md) | 中文

## Problem

安装器依赖宿主网络路径执行 Git clone 和 package installation。TLS 连接可能在 clone 中途关闭，留下 partial target directory，也没有用户操作可以改用其他代理重试。

## Decision

安装位置的高级选项包含可选 HTTP、HTTPS、SOCKS5 或 SOCKS5H proxy URL。main process 将代理传给 Git clone、pnpm version checks、dependency installation、build、upgrade、repair 和 update checks。WSL 通过所选 distribution 内显式的 env command 接收代理变量。代理 endpoint 保留在本地 runtime record 供维护操作使用，不写入 Harness settings 和 credentials 文件。

Git clone 和 dependency installation 各自重试三次。最终网络失败只清理真实且由 installer 所有的空目标目录，并返回结构化 retryable result。renderer 只对该 result 显示 Retry 操作；非网络失败保留错误，不提供无法恢复它的操作。

## Verification

Native Electron workflow 验证代理字段、去除认证信息的 review summary、经不可达本机代理触发的真实 Git failure、自动重试、目标清理和手动重试。Windows NSIS job 在打包前运行该 workflow。

## Alternatives considered

**要求用户手动配置 Git 和 pnpm proxy settings。** 否决，因为首次安装没有可靠的 Harness 配置，用户不应了解两套工具专用配置系统。

**对所有 installer failure 重试。** 否决，因为 build、配置和启动失败不会通过重复网络操作修复，错误操作会造成误导。

**保留 failed clone 以便续传。** 否决，因为 Git partial state 与新代理可能产生歧义；清理 installer 所有的目标目录让每次重试都从相同的空目录前置条件开始。

## Consequences

带认证信息的 proxy URL 可能保留在本地 runtime record 中以供维护命令复用；renderer summary 会在显示前移除认证信息。三次重试为网络失败增加有界等待时间，最终结果仍可操作，无需手动删除 partial directory。
