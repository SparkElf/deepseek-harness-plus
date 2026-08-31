# Agent Note: Plus浏览器认证策略

Status: implemented

[English](2026-08-30-plus-browser-auth-mode.md) | 中文

## 问题

Official Browser Auth通过per-process launch URL与具有30天absolute lifetime的signed browser cookie保护完整Host API。它没有login UI、expiry recovery UI，也没有打印及可选打开process URL以外的daemon-to-browser handoff。Plus作为persistent local Web service运行，因此访问clean URL可能只得到full-page 401，并要求operator从service output中恢复process token。

## 决策

Plus优先保证直接local Web access，并显式关闭browser identity。独立data-only source patch为`@deepseek-ai/dsh-client-connection`增加`browserAuthentication: required | disabled`；`required`保持official default。disabled strategy不创建process token或credential record，返回clean Web URL，接受index requests，并且只在既有Host/Origin trust fence通过后把请求视为authenticated。只有Plus profile选择`disabled`。

patch package只target exact official revision `cd5ef8148158c3a752a658978873241fdf8e2bbc`，且只拥有`packages/client/connection/`。`@sparkelf/dsh-plus`拥有selection、dependency closure、materialization及deployment lock。official `web` profile以及所有省略新字段的composition继续使用`required`，不增加compatibility path。

## 验证

现有Plus Playwright system acceptance针对exact official source materialize npm/profile distribution，在`127.0.0.1:3081`启动isolated service，让每个browser context通过无token与cookie的clean root URL进入，并在browser diagnostics启用时完成既有Settings、Backup、Document、DataOps、external-plugin、Turn-folding及mobile workflows。Production `3080`与`/root/.dsh`保持不变。

## 已考虑的替代方案

**增加或续期cookie lifetime。** 否决，因为它保留不可见expiry，且首次使用仍需要out-of-band handoff。

**从patched source全局删除Browser Auth。** 否决，因为这会静默改变official `web` profile，而非显式表达Plus product choice。

**从clean unauthenticated page签发cookie。** 否决，因为任何能访问该页面的browser都能取得同一identity，使authentication ceremony成为implicit bypass。

## 后果

所有能访问accepted authority的进程都能调用包含Shell、files与Sessions在内的完整Host API；该选择并非只作用于DataOps。shipped CLI仍绑定loopback并拒绝`--host 0.0.0.0`。Host/Origin rejection仍返回403，并继续阻止untrusted authorities、mismatched origins及cross-site browser requests，但它不建立user identity。

## 退役

official DSH暴露等价profile-selected browser-authentication policy后退役source patch。若official DSH后续提供完整且user-transparent的authentication与recovery workflow，再独立重新评估Plus的`disabled`选择。
