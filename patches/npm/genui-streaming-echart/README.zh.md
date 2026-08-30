# GenUI streaming EChart 补丁

[English](README.md) | 中文

这个data-only npm package为已验证的`@changfenhuang/dsh-genui 0.9.6` target携带一个temporary payload。`dsh-plus apply`通过Plus profile的pnpm `patchedDependencies` map选择并应用payload；安装本package不会运行npm lifecycle script。

该patch在enclosing top-level `items[]` component闭合前，不把nested tooltip、grid、axis、data及series object放入streaming render tree。这避免full-option EChart在paired yAxis到达前收到只有xAxis的中间option。Complete specs、complete bare-component roots、bounded candidate collection及settled rendering保持不变。

Upstream owner是[omdsh-dev/dsh-genui#87](https://github.com/omdsh-dev/dsh-genui/pull/87)。当npm release包含该变更，且真实DataOps到inline EChart Playwright路径在无browser diagnostics下通过后，删除本package、Plus dependency与patch-list entry及deployment-lock selection。

## Model Experience

本package不注册Cordis plugin、不增加model-visible text、不改变token usage，也不影响KV-cache reuse。External GenUI package继续拥有其`dsh-ui` teaching、parser、DOM/registry channels、components及interaction behavior。

## Known Limitations and Deferred Work

Package只支持`@changfenhuang/dsh-genui 0.9.6`。其他package content上的精确patch应用会响亮失败；不提供compatibility reader、runtime fallback、second renderer或console-error suppression。
