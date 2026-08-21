# Agent Note：Better Sidebar 为移动用户提供可操作的面板控件

Status: implemented

[English](2026-08-20-better-sidebar-mobile-feedback.md) | 中文

## Problem

默认 Web profile 挂载策展的第三方包 `dsh-better-sidebar`。手机没有选中会话时，其面板控件使用原生 disabled 按钮。控件虽然带有解释缺少会话的 Tooltip，但 disabled 按钮无法获得焦点，手机也没有 hover，因此点按没有任何可见反馈。选中会话后，移动抽屉声明 `width: 100vw`，左边框却位于 content box 之外，使面板实际比视口宽 1px。

这些行为属于外部插件。Plus 必须交付已经验证的修复，同时不接管源码所有权，也不能无限等待上游发版。

## Decision

Plus 把 npm 包钉扎到 `dsh-better-sidebar@0.14.0`，并通过 pnpm patched dependency 机制应用 `patches/dsh-better-sidebar@0.14.0.patch`。无会话控件从原生 disabled 改为 `aria-disabled`，因此保持不可执行，同时可以获得焦点，并向触摸和键盘用户显示既有 Tooltip。面板使用 border-box 尺寸，使声明的移动宽度包含边框。

策展清单记录上游 PR [#254](https://github.com/omdsh-dev/DSH-better-sidebar/pull/254) 和退役条件。包含该 PR 的 npm 0.14.1 或更高版本发布后删除补丁。外部项目继续拥有源码、发布和安全责任。

## Alternatives considered

- **等待上游合并并发版。** 拒绝，因为 Plus 用户报告的默认移动流程会继续没有反馈，而上游评审时间不受 Plus 控制。
- **依赖 SparkElf fork 或把插件源码复制进 Plus。** 拒绝，因为可变 fork 钉扎或 vendored 副本会改变第三方源码所有权，并建立第二条发布线。
- **编辑已安装的 node_modules。** 拒绝，因为重新安装后修改会消失，Windows 和发布制品也不会获得修改，而且没有经过评审的退役生命周期。

## Consequences

手机没有选中会话时，可以点按弱化控件并立即看到选择会话的解释。选中会话后，同一控件打开外宽等于视口的抽屉，内容不再因为面板位于屏幕外或发生溢出而逐字换行。桌面行为和 Better Sidebar 注册服务不变。

本地补丁是显式的临时分发事实。策展检查会拒绝缺少补丁文件、上游 URL 或退役条件的条目。

## Testing

项目 Mobile Bridge Playwright 命令通过已部署中继配对一台 Pixel 7，完成真实首次使用流程；无会话状态存在时验证控件的触摸 Tooltip；通过目录选择器选中 `/root/projects`，打开 Better Sidebar，等待滑入动画完成，并验证抽屉从 x=0 开始、宽度等于视口且控件位于屏幕内。同一流程继续覆盖设置、目录操作、双设备配对、定向下线，以及浏览器控制台和网络健康检查。
