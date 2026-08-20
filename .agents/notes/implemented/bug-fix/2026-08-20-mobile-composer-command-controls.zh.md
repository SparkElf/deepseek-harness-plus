# Agent Note：移动 composer 保留命令控件空间

Status: implemented

[English](2026-08-20-mobile-composer-command-controls.md) | 中文

## Problem

手机视口下，composer 尾部组仍保留桌面端的固有宽度。较长的已选模型名和推理等级会延伸到上下文指示器和发送按钮下方。触摸激活还会让 focus Tooltip 持续显示在命令按钮上方，命令已经执行后仍遮挡紧凑的 composer。

## Decision

视口不超过 640px 时，composer 为命令、上下文和主操作控件保留稳定轨道。只有模型 slot 使用剩余宽度，其既有标签省略在该宽度内生效。不隐藏模型文案、模式状态或命令。

`Tooltip` 通过锚点既有的 `onClick` 区分命令与解释。命令气泡在激活后关闭，同时焦点仍留在命令上。没有命令的锚点继续保留 focus 气泡，因此移动端 `aria-disabled` 控件仍能解释不可用原因。消费方可通过 `dismissOnClick={false}` 显式退出。

## Alternatives considered

- **在手机上隐藏模型名或推理等级。** 拒绝，因为已选路由是发送前的必要上下文；省略可以在不遮挡命令的前提下保留更多信息。
- **缩小所有尾部控件。** 拒绝，因为发送／停止和上下文进度需要稳定的触摸与阅读尺寸。
- **在触摸时关闭所有 focus Tooltip。** 拒绝，因为 Better Sidebar 等不可用控件依赖 focus 解释其使用条件。

## Consequences

长模型名会在上下文和主操作控件之前省略，不再与其重叠。激活命令、停止或发送后会移除对应 Tooltip，同时保留键盘焦点样式。没有命令的控件继续向触摸和键盘用户提供解释 Tooltip。

## Testing

Mobile Bridge Playwright 流程在 Pixel 7 宽度打开真实会话，验证可见模型控件与主操作控件不相交；聚焦命令控件显示 Tooltip，再通过触摸手势激活并验证 Tooltip 关闭。同一流程持续收集 console、页面错误、失败请求和意外服务端错误。
