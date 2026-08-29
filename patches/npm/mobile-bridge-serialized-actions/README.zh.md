# Mobile Bridge 串行action补丁

[English](README.md) | 中文

这个data-only npm package为已验证的`@sparkelf/dsh-mobile-bridge 0.2.8` target携带一个临时compatibility patch。`dsh-plus apply`在materialize npm profile时选择并应用payload；安装package不会通过npm lifecycle script修改依赖。

Compatibility declaration只覆盖已验证target version。精确patch-package、DSH、target-package、variant与payload选择属于deployment lock。

该patch保留已验收Plus移动工作流所需的串行action执行。其upstream pull request、owner与retirement status仍由Plus curated-plugin manifest拥有。当Mobile Bridge发布版本包含同等串行action行为时，从Plus distribution删除这个package。

## Model Experience

本package不注册Cordis plugin、不增加model-visible text、不改变token usage，也不影响KV-cache reuse。目标插件拥有其runtime与model experience。

## Known Limitations and Deferred Work

Package只支持已声明target package与payload。精确patch应用失败时不提供fallback implementation。
