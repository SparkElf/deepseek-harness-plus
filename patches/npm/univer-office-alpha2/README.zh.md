# Univer Office alpha.2 补丁

[English](README.md) | 中文

此 data-only npm package 直接修补 exact `dsh-univer-office@0.2.12` artifact。它保留现有 DSH alpha.2 Settings、Tool 输入、peer 版本和 Viewer socket lifecycle 兼容修改，同时回移 `univer_new.templateFile`、完整且不覆盖的 `.univer` 复制、供可信 Host 插件使用的可撤销只读模板根注册，以及通用的父页面到 Viewer 外部字体 manifest 通道。输出目标继续限制在 session workspace，注册的外部模板资产会先暂存到该 workspace，再交给 Gateway 创建；领域插件继续拥有并提供其字体二进制。

本 package 不在 DSH Host 插入 shim、adapter、fallback 或第二条运行路径。Single variant 只覆盖 DSH `>=0.1.2-alpha.2` 及 exact target；上游 release 同时包含原生 alpha.2 兼容和已授权模板创建后删除此 package。

## Model Experience

本 package 不注册 Cordis plugin。`dsh-univer-office` 继续独自拥有 bundled skills、tools、Gateway、Viewer 和模型体验；补丁只给现有 `univer_new` Tool 增加可选 `templateFile` 参数，不捆绑领域模板。

## Known Limitations and Deferred Work

Patch应用失败即停止，不提供模糊应用或未修补target fallback。
