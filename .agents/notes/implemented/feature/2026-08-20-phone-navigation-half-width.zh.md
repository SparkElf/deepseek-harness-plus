# Agent Note：手机主导航保持半屏

Status: implemented

[English](2026-08-20-phone-navigation-half-width.md) | 中文

## Problem

手动展开的主导航会在手机 frame 上复用 280px 桌面偏好。412px 视口下它会占据约 68% 屏幕，使会话区过窄，无法反复操作。选择 Session 或添加 Workspace 后自动收起虽然能恢复空间，却会中断用户明确展开导航后准备继续执行的后续导航。

## Decision

AppFrame 现在拥有用于观测和集成其渲染 grid 的 `data-dsh-frame` 标记。frame 宽度不超过 640px 时，它把用户手动展开的主导航列解析为实测 frame 宽度的一半。收起状态仍为 56px 控制轨道，详情栏保持关闭。手机宽度是派生规则而非存储的拖动偏好，因此 AppFrame 在该模式不渲染侧边栏拖动手柄。641px 到既有 narrow 断点之间的 frame 保持当前存储宽度行为。

选择 Session 和完成 Add Workspace 后，导航继续保持展开。这些操作仍只拥有各自的 Session 或 Workspace 结果；只有主外壳 toggle 会修改 `narrowExpanded` 并收起导航。

## Alternatives considered

- **手机继续使用 280px 桌面偏好。** 拒绝，因为 Pixel 7 宽度下只给会话区留下 132px，迫使会话控件进入不可用的压缩状态。
- **每次选择 Session 或 Workspace 后自动收起。** 拒绝，因为用户经常连续执行多个导航动作，并且正是为了这些动作才明确展开导航。
- **让手机半屏列可拖动。** 拒绝，因为渲染的半屏宽度是响应式规则，不是持久桌面偏好；无法保留结果的手柄会误导用户。

## Consequences

手机导航展开后，导航与会话各获得 frame 一半。用户可以连续选择多个 Session、添加 Workspace、搜索或继续其他导航动作，无需反复展开。只有用户激活收起控件后，会话区才获得整个 frame。桌面拖动宽度和平板 narrow 行为不变。

## Testing

AppFrame 测试把 412px 展开固定为 206px，保留 56px 轨道，省略手机拖动手柄，并保持 980px 行为。Pixel 7 系统流程在选择已开始 Session 和完成 Add Workspace 后分别断言导航仍为半屏，再由用户激活“收起侧边栏”，等待轨道稳定后验证 Better Sidebar 与 composer 几何。
