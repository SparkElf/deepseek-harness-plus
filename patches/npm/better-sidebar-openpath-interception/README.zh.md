# Better Sidebar alpha.2 文件打开补丁

[English](README.md) | 中文

这个data-only npm package把已验证的`dsh-better-sidebar 0.17.1` target从已删除的`ctx.workspaces.openPath`漏斗迁移到DSH alpha.2的`remote.session.openWorkspacePath` namespace。聊天文件链接会在侧边栏打开并返回Typert success envelope，不再穿透到Host操作系统。

本patch在既有Better Sidebar Settings与AppFrame payload之后组合。它保留target现有默认拦截设置，要求Session已选择非空cwd，在dispose时恢复namespace accessor，并只在拦截开启期间安装shadow。它也补齐已patch package从源码重建所需但此前缺失的`host-route-url.ts` source declaration。

## Model Experience

本package不注册Cordis plugin，也不增加model-visible text；它只恢复Better Sidebar在DSH alpha.2上的既有文件打开行为。

## Known Limitations and Deferred Work

Single variant只支持DSH `>=0.1.2-alpha.2`上的exact `dsh-better-sidebar 0.17.1`。独立发布的Better Sidebar版本包含同一remote namespace实现后删除本package。
