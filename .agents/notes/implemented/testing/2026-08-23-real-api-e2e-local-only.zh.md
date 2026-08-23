# Agent Note: 真实API e2e仅限本地运行

Status: implemented

[English](2026-08-23-real-api-e2e-local-only.md) | 中文

## Problem

真实提供方测试依赖外部凭据和提供方可用性。在GitHub Actions中运行这类测试，会让PR、默认分支构建、定时任务和Release依赖仓库secret及外部服务。缺少secret会导致CI失败，但不会发现仓库回归。

## Decision

GitHub Actions保持keyless。任何workflow都不读取`DEEPSEEK_API_KEY`或`DEEPSEEK_API_KEY_EXTERNAL`，任何CI/CD事件都不运行`pnpm run test:e2e`。该命令只供明确提供本地凭据的操作员运行；缺少本地密钥时，套件自行跳过。

仓库PR检查使用keyless的静态检查、覆盖率、快照、产物、兼容性、Python和浏览器证据。真实API结果只作为可选的本地诊断证据，永远不是Required、aggregate、Release、schedule或手动GitHub Actions检查。

本决策取代已归档的[真实API e2e CI决策](../../archived/testing/2026-06-19-real-api-e2e-ci.md)。

## Alternatives considered

**保留trusted-event workflow。** Trusted event可以避免向fork暴露secret，但PR和默认分支构建仍然依赖secret配置及提供方可用性。

**保留手动GitHub Actions dispatch。** 手动dispatch仍然把凭据和真实提供方调用放在CI/CD中，不符合keyless workflow策略。

**删除真实API套件。** 操作员在本地运行它仍能获得有价值的提供方诊断，因此套件只退出CI/CD，不从仓库删除。

## Consequences

GitHub Actions无法检测只在真实提供方上出现的回归。Keyless快照和浏览器用例继续提供自动化证据；需要真实提供方证据时，操作员可以在本地运行`pnpm run test:e2e`。CI/CD不再需要DeepSeek API仓库secret。

## Verification

CI workflow specification扫描所有GitHub Actions workflow，并拒绝任何`DEEPSEEK_API_KEY`引用。专用真实API workflow不存在，贡献者文档把`pnpm run test:e2e`标记为仅限本地运行。
