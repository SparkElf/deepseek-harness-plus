# Agent Note: 会话授权的文档预览标签页

Status: implemented

[English](2026-08-31-session-authorized-document-preview.md) | 中文

## 问题

Chat及Trajectory中的durable Document cards通过attachment store中的immutable original叇parser artifacts标识内容，而Better Sidebar的standard file viewer打开Session Workspace中的mutable path。把每个attachment复制到Workspace会让Session history依赖可被用户、tools、Git operations或Workspace deletion修改或删除的files。传递attachment store的host path会暴露provider-private layout并绕过Session reference check。只带metadata的custom tab虽保留attachment address，但Better Sidebar 0.17.1不会为该content open显示已折叠panel。

## 决策

Attachment store仍是唯一durable byte owner。Document block记录original attachment及其parser artifacts；Chat及Trajectory只投影card所需的parsed-Markdown attachment id及display metadata。Document plugin打开一个hidden Better Sidebar tab；其`id`源自preview content address及display name，`title`是该display name，`path`是parsed-Markdown content address。Presentation data或`tab.meta`不会持久化未使用的original id或重复card object。

Better Sidebar持有tab placement、persistence、deduplication、activation及panel reveal。由于open带有`path`，其现有content-open behavior无需修改Better Sidebar即可显示已折叠panel。Custom tab只在`document-attachment` tab type内解释该path；它不会调用`openFile`或Workspace filesystem API。

Document plugin通过Client Session binding解析content address。Session attachment operation先证明active或persisted Session log引用requested original、parser artifact或extracted image，再委托mounted attachment provider的generic-file或image read。Client接收verified bytes，preview使用localized Markdown controls渲染parser-produced Markdown；empty parser artifact会渲染localized no-text state，而不是blank panel。Physical attachment-store paths不会跨越Host/Client interface。

## 已考虑的替代方案

**把每个accepted Document复制到Session Workspace并调用`openFile`。** 未采用，因为Workspace可变、可由多个Sessions共享、会产生filename及Git-status side effects，且可在Session history仍然valid时消失。

**向Better Sidebar添加attachment protocol或`reveal` option。** 未采用，因为typed custom tab已可接收persisted content locator，且Better Sidebar已会显示带`path`的open；扩大external plugin API会为一个current consumer添加第二套resource vocabulary。

**传递attachment store的absolute object path。** 未采用，因为该path属于local provider，没有stable filename或extension，可能位于Workspace fence之外，且无法跨provider change保持。

## 后果

Chat及Trajectory cards会打开同一个deduplicated preview tab，并在不修改Better Sidebar的情况下重新打开已折叠panel。Session history不依赖Workspace mutation，preview read保留Session authorization及attachment integrity checks。Sidebar明确呈现semantic Markdown，而非page-faithful PDF或Office rendering。未来的显式“保存到Workspace”action可创建derived mutable copy，但该copy不是history preview的prerequisite或authority。
