# Plus 托盘管理器

状态：开发中

[English](INSTALLER.md)

## 你要完成的事

你始终通过 DeepSeek Harness 的 Web 页面使用产品。桌面应用会提供一次性的初始安装引导，随后常驻系统托盘，让你不用回到终端也能管理本地 runtime。

## 初始安装

本地服务尚未存在时，安装引导会询问空安装目录、本地端口、DeepSeek API key、默认模型和可选推理强度。它会 clone 并构建 Plus，把这些初始值写入隔离的 DSH_HOME，启动服务，打开浏览器页面，然后关闭引导窗口。

![初始安装引导](assets/plus-installer-model.png)

引导不是第二套设置中心。安装后，Web 页面拥有模型变更、凭据、预设、工作区选择和所有 agent 交互。托盘管理器没有这些设置的菜单项，也不会在初始安装后读取凭据文件。检出成功后，即使后续依赖或构建失败，托盘仍会保留修复操作，而不会声称安装已经完成。

## 托盘操作

- 安装 Plus：本地 runtime 不存在时打开初始引导。
- 启动服务：启动已配置的本地 Web 服务，并等待它报告监听 URL。
- 停止服务：结束本地 Web 服务，但保留所有本地状态。
- 打开 DeepSeek Harness：在浏览器中打开已配置的本地 URL。
- 升级 Plus：快进更新检出、恢复锁定依赖、重新构建；服务原本在运行时会重新启动。
- 修复安装：恢复锁定依赖并重新构建当前检出。

source-build 安装器要求本机已经安装 Git 和 pnpm。它会在 clone 任何仓库前检查这两个工具，并在安装引导中报告缺失项。

## 平台

当前公开安装包目标是 Linux AppImage/deb 和 Windows NSIS。每种安装器都必须在对应 runner 上完成构建和验证后才能发布。macOS 源码支持延后到配置好 Developer ID 签名和 notarization 后再恢复；未签名的 DMG 不是正式安装器。

## 当前发布状态

初始安装引导、托盘管理器源码以及 Linux AppImage/deb artifact 已在本地实现。目前还没有可下载的安装器或 Plus release。发布前仍需要 Windows 和 macOS artifact、原生桌面验证以及人工 PR 审批。
