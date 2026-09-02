# Univer Office alpha.2 补丁

[English](README.md) | 中文

此data-only npm package直接修补exact `dsh-univer-office@0.2.12` artifact。DSH alpha.2删除了runtime `settingsNamespace` export；target已有literal `univer-office` namespace，payload删除helper import并把该literal直接传给public Settings service，同时把已核验的alpha.2 Host peer版本写入target manifest。真实GPT tool calls还会把omitted optional strings具化为空白值，因此target Tool ingress将空白optional strings视为absent，同时保留所有action-required字段错误。Exact bundled Viewer仅在native WebSocket为open时发送collaboration frames，消除close-time console error且不修改global WebSocket behavior。浮动实时预览改为默认关闭，发送消息不再遮挡会话；用户仍可在Univer Office设置中主动开启，会话审阅卡片不受影响。

本package不在DSH Host插入shim、adapter、fallback或第二条运行路径。Single variant只覆盖DSH `>=0.1.2-alpha.2`及exact target；upstream发布原生alpha.2 Settings、Tool输入及Viewer socket lifecycle支持后删除此package。

## Model Experience

本package不注册Cordis plugin、不增加model-visible text。`dsh-univer-office`继续独自拥有其bundled skills、tools、Gateway、Viewer及模型体验。

## Known Limitations and Deferred Work

Patch应用失败即停止，不提供模糊应用或未修补target fallback。
