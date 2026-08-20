# Agent Note：移动 composer 保留命令控件空间

Status: implemented

[English](2026-08-20-mobile-composer-command-controls.md) | 中文

## Problem

手机视口下，composer 尾部组仍保留桌面端的固有宽度。较长的已选模型名和推理等级会延伸到上下文指示器和发送按钮下方，模型菜单打开后还会被该 slot 裁掉。触摸激活也会让 focus Tooltip 持续显示在命令按钮上方，命令已经执行后仍遮挡紧凑的 composer。活动会话的 transcript 渐隐看起来像 docked composer 后方的光晕；新建会话 hero 标题会换行，预期的蓝色光晕还跟随外层 stack 而不是输入卡片。

## Decision

视口不超过 640px 时，composer 为命令、上下文和主操作控件保留稳定轨道。只有模型 slot 使用剩余宽度：trigger 标签在该宽度内省略，浮层菜单则保持可见并可显示在 slot 之外。不隐藏模型文案、模式状态或命令。活动会话在这些宽度下省略桌面端 transcript 渐隐。新建会话标题使用一档固定的移动端字号且不换行；其光晕跟随实际输入卡片宽度，只在移动端断点提高椭圆 alpha。

`Tooltip` 通过锚点既有的 `onClick` 区分命令与解释。命令气泡在激活后关闭，同时焦点仍留在命令上。没有命令的锚点继续保留 focus 气泡，因此移动端 `aria-disabled` 控件仍能解释不可用原因。消费方可通过 `dismissOnClick={false}` 显式退出。

## Alternatives considered

- **在手机上隐藏模型名或推理等级。** 拒绝，因为已选路由是发送前的必要上下文；省略可以在不遮挡命令的前提下保留更多信息。
- **缩小所有尾部控件。** 拒绝，因为发送／停止和上下文进度需要稳定的触摸与阅读尺寸。
- **在触摸时关闭所有 focus Tooltip。** 拒绝，因为 Better Sidebar 等不可用控件依赖 focus 解释其使用条件。
- **在所有宽度删除 transcript 渐隐。** 拒绝，因为桌面 transcript 与 composer 几何仍使用既有渐隐；只有窄屏活动会话会把它呈现成错误的光晕。
- **在手机上隐藏预览徽标。** 拒绝，因为预览状态仍是产品信息；固定移动端字号即可让标题与徽标占用同一行。

## Consequences

长模型名会在上下文和主操作控件之前省略，不再与其重叠；打开模型选择器会显示完整菜单。激活命令、停止或发送后会移除对应 Tooltip，同时保留键盘焦点样式。没有命令的控件继续向触摸和键盘用户提供解释 Tooltip。活动移动会话保持安静的 docked composer；移动端新建会话保留与卡片对齐的蓝色光晕，并把品牌标记、标题与预览徽标放在同一行。

## Testing

Mobile Bridge Playwright 流程在 Pixel 7 宽度打开真实会话，验证可见模型控件与主操作控件不相交，通过触摸手势打开模型菜单并验证完整菜单可见。它再聚焦命令控件显示 Tooltip，经触摸激活并验证 Tooltip 关闭。已配对手机新建会话，验证本地化标题与预览徽标并列且标题只占一行，再返回真实会话。同一流程持续收集 console、页面错误、失败请求和意外服务端错误。
