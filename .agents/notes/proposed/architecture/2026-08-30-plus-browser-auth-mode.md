# Agent Note: Plus browser-authentication policy

Status: proposed

English | [中文](2026-08-30-plus-browser-auth-mode.zh.md)

## Problem

Official Browser Auth protects the complete Host API through a per-process launch URL and a signed browser cookie with a 30-day absolute lifetime. It has no login UI, expiry recovery UI, or daemon-to-browser handoff beyond printing and optionally opening the process URL. Plus runs as a persistent local Web service, so opening its clean URL can instead produce a full-page 401 and require the operator to recover a process token from service output.

## Decision

Plus prioritizes direct local Web access and explicitly disables browser identity. An independent data-only source patch adds `browserAuthentication: required | disabled` to `@deepseek-ai/dsh-client-connection`; `required` remains the official default. The disabled strategy creates no process token or credential record, returns the clean Web URL, admits index requests, and treats requests as authenticated only after the existing Host/Origin trust fence succeeds. The Plus profile alone selects `disabled`.

The patch package targets exact official revision `cd5ef8148158c3a752a658978873241fdf8e2bbc` and owns only `packages/client/connection/`. `@sparkelf/dsh-plus` owns selection, dependency closure, materialization, and the deployment lock. The official `web` profile and every composition that omits the new field retain `required` without a compatibility path.

## Security consequence

Every process that can reach an accepted authority can call the complete Host API, including Shell, files, and Sessions; this choice is not scoped to DataOps. The shipped CLI still binds loopback and rejects `--host 0.0.0.0`. Host/Origin rejection remains 403 and continues to block untrusted authorities, mismatched origins, and cross-site browser requests, but it does not establish user identity.

## Verification

The existing Plus Playwright system acceptance materializes the npm/profile distribution against the exact official source, starts the isolated service on `127.0.0.1:3081`, enters every browser context through the clean root URL without a token or cookie, and completes the existing Settings, Backup, Document, DataOps, external-plugin, Turn-folding, and mobile workflows with browser diagnostics enabled. Production `3080` and `/root/.dsh` remain untouched.

## Alternatives considered

**Increase or renew the cookie lifetime.** Rejected because it preserves an invisible expiry and still requires an out-of-band first handoff.

**Remove Browser Auth globally from the patched source.** Rejected because it would silently change the official `web` profile instead of making the Plus product choice explicit.

**Mint a cookie from the clean unauthenticated page.** Rejected because any browser able to reach that page would obtain the same identity, making the authentication ceremony an implicit bypass.

## Retirement

Retire the source patch when official DSH exposes an equivalent profile-selected browser-authentication policy. Re-evaluate the Plus `disabled` selection separately if official DSH later provides a complete, user-transparent authentication and recovery workflow.
