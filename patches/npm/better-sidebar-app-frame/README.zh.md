# Better Sidebar AppFrame 补丁

[English](README.md) | 中文

这个data-only npm package为已验证的`dsh-better-sidebar 0.17.1` target携带一个临时compatibility payload。`dsh-plus apply`在materialize npm profile时选择并应用一个payload；安装package不会通过npm lifecycle script修改依赖。

Single variant只覆盖已验证的`0.17.1` target。accepted production使用的local `0.17.0` artifact已包含相同AppFrame与Host-route behavior，不需要payload。精确patch-package、DSH、target-package、variant与payload选择属于deployment lock。

该patch保留Plus Web组合已验收的AppFrame间距。其upstream pull request、owner与retirement status仍由Plus curated-plugin manifest拥有。当Better Sidebar发布版本包含同等AppFrame行为时，从Plus distribution删除这个package。

## Model Experience

本package不注册Cordis plugin、不增加model-visible text、不改变token usage，也不影响KV-cache reuse。目标插件拥有其runtime与model experience。

## Known Limitations and Deferred Work

Package只支持已声明target package与payload。精确patch应用失败时不提供fallback implementation。
