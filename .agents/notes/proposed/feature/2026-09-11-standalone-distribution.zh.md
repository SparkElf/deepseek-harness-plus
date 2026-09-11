# Agent Note：独立 Plus 发行版

Status: proposed

[English](2026-09-11-standalone-distribution.md) | 中文

## Problem

今天安装 Plus 需要 git、一份 official source checkout，以及约九分钟的 official build。想要产品而非源码的用户没有受支持的路径：distribution 携带 source patches，而 patch 意味着 source tree。

## Decision

发布 @sparkelf/dsh-plus-standalone：一个 registry package，其 dependencies 携带受审的 plugins，其首次 start 写出 launcher 启动的 profile。用户安装一个 package 并运行一条命令；无需源码、无需构建、无需 git。

## Alternatives considered

**打包完整依赖树**（official Desktop 的做法，+300MB）。经实测后拒绝：正常的 npm install 已满足每一项 official import，因为 service-definition packages 以 peer 形式到达。只有 legacy-peer-deps flag 才会产生促成该想法的缺口。

**保留 source-patch 路径作为唯一发行方式。** 被拒绝，因为它无法服务没有工具链的用户。

## Consequences

plugins 精确 pin 其 DSH peers，因此 runtime bump 必须先重新发布，standalone package 才能安装。目前有十一个 package 发布的 peers 与其源码矛盾；门禁记录该漂移并对新漂移失败。

## Proposal

新 package @sparkelf/dsh-plus-standalone 把每个受审 plugin 声明为 dependency，并携带 launcher 挂载的 bundle order。一层 dsh-plus command 负责 launcher 留给用户的 lifecycle：start 在首次运行时创建 profile 并选择空闲端口，stop 结束后台 server，status 报告 URL，doctor 检查安装。

## Acceptance criteria

- 没有 source checkout 的 consumer 安装该 package 并到达 browser UI。
- start 按 distribution bundle order 创建 profile，无需手工编辑 manifest。
- 端口被占用时移到下一个空闲端口，而不是以 bind error 失败。
- stop 在 grace period 内结束后台 server。
- doctor 把解析到 consumer tree 之外的 distribution 报告为 failure。

## Risks

- exact DSH peer 无法就地修正，因此未重新发布的 runtime bump 会阻塞安装。plugins repository 以记录基线的方式对新漂移做门禁。
- 端口搜索可能选中用户未预期的端口；命令会打印该替换。

## Verification

`dsh-plus` CLI 从 consumer tree 解析其 distribution，按 distribution 的 bundle order 创建 profile，并在首选端口被占用时移到下一个空闲端口；解析到 consumer tree 之外的 distribution 会让 `doctor` 失败，而不是报告健康。plugins repository 以记录基线的方式对新 peer 漂移做门禁。
