# Agent Note：面向用户的 Plus Release 资产

Status: implemented

[English](2026-09-07-user-facing-plus-release-assets.md) | 中文

## Problem

Plus GitHub Release 已经变成内部发布工作的投影。npm tarball、profile 闭包归档、截图、配置文件、校验和以及平台安装包共同出现在一个资产列表中。这些文件对包发布者和评审者有用，但普通用户只需要一个明确的安装器。GitHub 已经为每个 Release tag 提供源码归档，因此上传包归档和验证证据只会增加产品 Release 的使用难度，并未增加安装路径。

Desktop 安装器已经内嵌审阅后的 Plus 闭包。因此，安装和修复都不要求在安装器旁逐个发布闭包 tarball。

## Decision

面向用户的 Plus Release 使用 `plus-vX.Y.Z` 产品 tag，并从没有手工资产的状态开始。唯一手工上传的资产是一个名为 `DeepSeek.Harness.Plus.Setup.<desktop-version>.exe` 的 Windows Desktop 安装器。GitHub 自动生成的 `Source code (tar.gz)` 和 `Source code (zip)` 链接就是源码分发，不再重复上传。

npm package tarball 保留在 npm registry，CI package 输出保留在 Actions artifact。`plus-npm-v*` tag 可以标识 npm 发布序列，但不创建面向用户的 GitHub Release。除非用户在某次发布前明确更改发布策略，否则不包括截图、配置文件、block map、校验和、验证证据包、AppImage 文件和 Debian package。

`Sync Desktop Installer` workflow 只下载 `*.exe`，要求下载文件数恰好为 1，拒绝已经存在任何手工资产的目标 Release，不使用 `--clobber` 上传，并验证发布后的资产清单只包含一个符合预期命名的安装器。`scripts/ci-workflow.spec.ts` 固定这些检查，防止后续 workflow 修改在未被发现的情况下恢复混合资产列表。

Release notes 只包含产品和组件版本、official source revision、前置条件、签名状态以及安装器 SHA-256，不包含内部 profile 路径、测试截图和逐包清单。

## Alternatives considered

**公开完整闭包以提高透明度。** 不采用，因为 npm 和 Actions 已经保留这些文件，而 Desktop 安装器也携带安装闭包。在产品 Release 中重复发布只会隐藏受支持的入口。

**默认发布 Windows、AppImage 和 Debian 安装包。** 当前策略不采用，因为用户要求只提供一个 Desktop 安装器。未来版本只有在发布前明确修改策略后才能增加平台。

**保留一个混合 Release，并在说明中解释每项资产。** 不采用，因为文档无法消除下载列表本身的歧义。资产范围必须由自动检查强制执行。

## Consequences

Plus 产品 Release 只呈现一个主要操作和 GitHub 自动生成的源码归档。内部 npm 发布和验证产物仍保留在各自归属系统中，但不再显示为产品下载。

如果目标 Release 已经存在任何手工资产，sync workflow 就不能更新它。修正Release时应创建新的产品 tag 和空 Release，而不是继续累积或替换无关文件。增加其他平台需要先评审并修改策略和测试。
