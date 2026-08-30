# Better Sidebar alpha.2 Settings 补丁

[English](README.md) | 中文

这个data-only npm package为已验证的stable `dsh-better-sidebar 0.17.1` target携带一个compatibility payload。DSH alpha.2删除了runtime `settingsNamespace` export；该payload保留target的`SettingsConflictError` import，并把既有literal namespace直接传给public Settings service。

Single variant覆盖DSH `>=0.1.2-alpha.2`与exact `dsh-better-sidebar 0.17.1`。Target已拥有schema、reads、writes、conflict handling及lifecycle；该patch只修改已删除的namespace helper调用。Stable Better Sidebar release包含alpha.2 Settings contract后删除这个package。

## Model Experience

本package不注册Cordis plugin、不增加model-visible text、不改变token usage，也不影响KV-cache reuse。Better Sidebar拥有其runtime与model experience。

## Known Limitations and Deferred Work

Package只支持已声明target；exact patch应用失败时不提供fallback。
