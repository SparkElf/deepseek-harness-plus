# Agent Note：受信托管集成只使用一个授权主体

Status: implemented

[English](2026-09-01-managed-integration-single-authorization-principal.md) | 中文

## 问题

平台托管的DSH与平台API属于同一个明确受信任域。DSH本来就能执行当前用户获准使用的平台能力，因此向DSH隐藏平台JWT并不会降低其权限。

派生credential及复制的权限状态会为同一主体增加签名、续期、传输及生命周期代码。这些层没有建立更小的信任域，却产生了独立的过期与失败owner。

## 决策

- Managed DSH获取托管平台当前access JWT，并只用它承载身份与会话凭证。
- 平台在每次API或工具操作中校验JWT及会话，再解析当前角色、权限与资源授权。
- Gateway、插件和sidecar直接转发JWT，不增加内部path、scope、role或权限过滤。
- Companion可以提供进程或资源隔离，但不隐藏平台JWT，也不拥有Agent任务生命周期。
- JWT过期只拒绝新的平台操作，不取消已接受的turn、不关闭其观察流，也不重启或删除runtime；后续请求使用刷新后的JWT。
- Standalone DSH或另一个明确独立的信任域可以使用OAuth 2.0/OIDC及更窄凭证。
- 实现删除重复凭证和状态机，不在其上叠加兼容逻辑。

## 考虑过的替代方案

**为浏览器入口增加第二凭证。** 在managed信任域内否决，因为它重复身份、有效期、续期与撤销，而DSH仍拥有用户的平台权限。

**由DSH外部间接持有身份。** 否决，因为该间接层掩盖已声明的权限，并把认证耦合到sidecar与容器生命周期。

**Managed DSH使用delegated OIDC。** 否决，因为authorization-code exchange适用于不同客户端或信任域，而非平台及其受信托管runtime。

## 后果

Managed integration只有一个平台JWT及一套平台权限机制。Browser、Gateway、插件、sidecar、Agent与容器代码不复制授权策略，也不把凭证过期绑定到任务和runtime生命周期。Standalone认证保持独立可配置。

被攻破的managed DSH可以行使平台当前授予该JWT主体的确切权限。这是明确的managed runtime受信前提；JWT生命周期、撤销、审计及最小角色权限仍由平台负责。
