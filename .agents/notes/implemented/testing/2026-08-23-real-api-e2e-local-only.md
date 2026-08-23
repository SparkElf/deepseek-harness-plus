# Agent Note: Real-API e2e is local-only

Status: implemented

English | [中文](2026-08-23-real-api-e2e-local-only.zh.md)

## Problem

Live-provider tests require external credentials and provider availability. Running them in GitHub Actions makes pull requests, default-branch builds, schedules, and releases depend on repository secrets and an external service. A missing secret produces a failed CI run without finding a repository regression.

## Decision

GitHub Actions remains keyless. No workflow reads `DEEPSEEK_API_KEY` or `DEEPSEEK_API_KEY_EXTERNAL`, and no CI/CD event runs `pnpm run test:e2e`. The command remains available only for a local operator who explicitly provides provider credentials; suites self-skip when their local key is absent.

The repository PR checks use keyless static, coverage, snapshot, artifact, compatibility, Python, and browser evidence. Real-API results are optional local diagnostic evidence and are never a required, aggregate, release, scheduled, or manual GitHub Actions check.

This decision supersedes the archived [real-API e2e CI decision](../../archived/testing/2026-06-19-real-api-e2e-ci.md).

## Alternatives considered

**Keep the trusted-event workflow.** Trusted events prevent fork secret exposure, but pull requests and default-branch builds still depend on secret configuration and provider availability.

**Keep a manual GitHub Actions dispatch.** Manual dispatch still places the credential and live-provider call inside CI/CD, contrary to the keyless workflow policy.

**Delete the real-API suite.** Local operator runs still provide useful provider diagnostics, so the suite remains available outside CI/CD.

## Consequences

GitHub Actions cannot detect regressions that appear only against a live provider. Keyless snapshots and browser cases remain the automated evidence, while an operator can run `pnpm run test:e2e` locally when live-provider evidence is useful. CI/CD no longer needs a DeepSeek API repository secret.

## Verification

The CI workflow specification scans every GitHub Actions workflow and rejects any `DEEPSEEK_API_KEY` reference. The dedicated real-API workflow is absent, and contributor documentation identifies `pnpm run test:e2e` as local-only.
