# Agent Note: Accept a profile after changing it, or systemd refuses the restart

Status: proposed

[English](2026-09-19-accept-a-profile-after-changing-it.md) | 中文

## Problem

运行 Plus supervisor 的 systemd 单元在 supervisor 启动之前执行一道 guard：

```
ExecStartPre=.../profile-guard.mjs guard --state /root/.dsh/supervisor/accepted-profile.json
```

该 guard 对 profile 的运行时闭包取指纹，并与先前验收的状态比对。**对该闭包的【任何】改动都会拒绝启动**，而由于单元声明了 `Restart=on-failure`，一次重启随后会反复失败，把部署留在停机状态：

```
profile-guard: accepted Plus profile runtime closure was modified
profile-guard: after changing the profile, record it with
               'profile-guard.mjs accept --profile <dir> --profile-link <link> --manifest <file> --state <state>'
deepseek-harness-plus.service: Failed with result 'exit-code'.
```

在本机实测：三次启动失败相隔 11 秒，服务一直停着，直到有人手工 accept 该 profile。

**没有任何东西在需要它的那一刻提示这条要求。** guard 把提示打到 journal 里，而没人会在服务已经停机之前去读它。改动经由若干常见途径抵达 profile —— 装插件、修链接、打补丁 —— 每一条都静默地让那次验收失效。

## What happened

修复 release scope（`relink-release.mjs --profile`）时给生产 profile 的 `node_modules` 补了链接，而那正是 guard 取指纹的那个闭包。紧接着是一次重启，systemd 拒绝了它三次。恢复靠的是手工 `accept`。

修复本身是正确且必要的；缺的是改动与重启之间那一步验收。

## Proposal

**对 profile 的改动与随后的重启属于同一个序列，并由该序列承担验收。**

`dsh-change` 按顺序执行六步，并在第一个失败的关口退出，同时不动正在运行的服务：

1. **重链 release scope。** release 既从自己的 `node_modules` 解析 `@deepseek-ai` 名字，也从 profile 解析；而在 release 内跑一次安装会把前者重写成它自己声明的那几个包。正在运行的服务照常工作，因此这个故障在重启之前都不可见。
2. **执行命令** —— 一次安装、一次链接、一次打补丁。
3. **再次重链**，因为那条命令可能重写过该 scope。
4. **在备用端口上验证**（`dsh-verify`）。如此，一个无法启动的 profile 是一次失败的检查，而不是一次事故。
5. **验收该 profile**，交给 guard。走到这一步意味着第 4 步已经证明它能启动。
6. **重启单元并确认**它处于 active 且它自己的端口有应答。

**演练单元的存在正是为了让这个序列可以被演练。** `dsh-rc30-staging.service` 以另一个端口运行同一个 release，拥有自己的 `DSH_HOME` 与自己的 guard 状态，于是整个六步都跑在一个失败不付代价的服务上。

## Findings this change rests on

1. **guard 取指纹的是闭包，不是清单。** `fingerprintProfile` 对每个包目录下的每个运行时文件求哈希，因此新增一个符号链接就会改变它。
2. **一次失败的启动会重复。** `Restart=on-failure` 配 `RestartSec=2` 产生了三次尝试，随后是 `Start request repeated too quickly`。
3. **验收是按 profile 链接分别记录的。** 状态里记录 `profileLink` 与 `acceptedProfile`，因此演练实例需要自己的状态文件，而不是生产的那份。
4. **guard 需要一份 manifest。** `accept` 会读 `runtime.json` 以记录它保存的运行时配置；演练实例需要自己的那份副本。
5. **第 6 步必须读取单元自己的端口。** 确认信息里写死的 `3080`，在同一个序列跑向演练单元时报告了错误的服务。

## Acceptance criteria

- 改动 profile 的命令之后、任何重启之前，先有一次验收。
- 无法启动的 profile 在单元被触碰之前就让序列失败。
- 序列在第一个失败的关口以非零退出，并点名该关口。
- 确认信息报告被重启单元实际服务的那个端口。
- 演练实例在不影响运行中部署的前提下跑同一个序列。

## Alternatives considered

**在重链辅助脚本里自动验收。** 否决：验收断言该闭包是【有意为之】的，而辅助脚本无从知道这一点。那是操作者的一次声明，在 profile 已被证明能启动之后作出，且只作一次。

**关掉 guard。** 否决：正是它抓到了一个闭包已与验收状态漂移的 profile。缺口在于缺少那一步验收，而不在于这道检查。

**改完 profile 就一条命令重启、不做验证。** 否决：这正是造成本次事故的做法。第 4 步的存在，是为了让这次重启成为 profile 的第二次启动，而不是第一次。

## Risks

**该序列需要一个备用端口。** 验证会启动一个真实实例，因此没有空闲端口的部署无法在重启前完成验证。

**一个能启动并且已被验收的 profile 仍可能是错的。** guard 与验证检查的是闭包能否加载，而不是那次改动是否就是想要的那次；一个装错的插件同样会被验收并被服务。
