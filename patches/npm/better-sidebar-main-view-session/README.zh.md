# @sparkelf/dsh-patch-better-sidebar-main-view-session

[English](README.md) | 中文

这个纯数据包给 `dsh-better-sidebar@0.19.1` 打补丁。侧边栏从 `sessions.list.current` 读取当前会话；DSH 0.1.6-alpha.2 移除了该字段，于是这个读取得到 `undefined`，而 `store.setSession(undefined)` 清空了会话。此后每次点击文件都会走到 `openFile` → `openTab`，而后者在 store 没有会话 id 时不打开任何东西直接返回 —— 一次不打开标签、不发请求、不留日志的点击，对所有文件类型都是如此。

载荷只改 `lib/client.js`：新增 `mainViewSessionId` 并经由它读取会话。运行时有 `list.current` 时该函数返回它，否则复刻运行时自身 ui-session 服务挑选主视图所用的规则：`retainedBy.mainView` 计数为正的那一行。因此同一份构建同时服务两代运行时。它刻意不回退到列表首行 —— 目录顺序即宿主顺序，多个会话打开时侧边栏会绑定到用户并未查看的那个会话。

## Model Experience

无。本补丁改变的是侧边栏绑定哪个会话；没有模型可见的输入、工具结果、提示词或会话事件发生变化。

## Known Limitations and Deferred Work

- **本补丁钉住 `dsh-better-sidebar@0.19.1`。** 后续版本若自行采纳 alpha.2 的规则，本补丁会变得多余而非错误；届时退役它。
- **该函数按结构读取 `retainedBy`。** 运行时若重命名该保留字段，侧边栏会再次失去绑定，与打本补丁之前完全一样，而不会响亮地失败。
