# Agent Note: HTTP 200 does not prove a deployment works

Status: proposed

English | [中文](2026-09-19-http-200-does-not-prove-a-deployment-works.zh.md)

## Problem

On this host, every message on the production deployment failed with:

```
本轮运行失败  Cannot read properties of undefined (reading 'prepare')  UNKNOWN
```

The turn never ran. Every tool call failed, for every session, regardless of what was sent.

**Every check available at the time was green.** The page loaded, the client's 74 modules all resolved, the WebSocket upgraded with 101, and the readiness line printed. A verification that stopped at any of those would have declared the deployment healthy while no tool could run at all.

## Why it happened

A tool call passes through two module loaders, and both must hold the **same** module instance, because the scheduler is published under a module-level Symbol:

```js
// packages/core/tools
const TOOL_RUNTIME_SCHEDULER = Symbol('@deepseek-ai/dsh-tools.scheduler')

// packages/core/agent-loop
const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)
```

The release's `agent-loop` resolves `@deepseek-ai/dsh-tools` from the release tree; the profile's loader resolves the registry from `profile/node_modules`. When both hold the package — a **real directory in the profile scope** rather than a link — the process carries two instances, two Symbols, and the lookup returns `undefined`.

Measured on the two profiles:

| | links | real directories |
|---|---|---|
| known-good | 305 | **0** |
| failing | 296 | **23** |

A source synchronization had moved 11 release packages' `node_modules` out of the release and into real directories in the profile scope. Repairing it needs both halves: move the real directories back to links **and** restore the nested `node_modules` inside the release packages, because a release package that becomes the resolution subject without its own dependencies reports `Cannot find package 'compression'` instead.

## Proposal

**Verification asks what a tool call needs, not what a page needs.**

`check-module-identity.mjs` resolves one package that both sides carry, from each side, and compares the results:

```
release side: .../packages/core/tools/package.json
profile side: .../packages/core/tools/package.json
RESULT: ok - one module instance for @deepseek-ai/dsh-tools
```

A profile scope holding a real directory where the release ships a package makes those differ, and the check exits 1 with the message a caller would otherwise see only from a user. It is now part of `dsh-verify`, so no verification passes while tool dispatch is broken.

The layers below all stay; each answers a different question, and this one answers the question none of them asked:

| layer | question |
|---|---|
| readiness line | did the process start |
| `verify-client.mjs` | do the client's modules resolve |
| `ws-check.mjs` | does the transport upgrade |
| `check-profile-scope.mjs` | is the profile scope shadowing the release |
| **`check-module-identity.mjs`** | **will a tool call find one Symbol** |

## Findings this change rests on

1. **The failure is invisible to HTTP.** Status 200, a complete client bundle, and a 101 upgrade all held while every tool call failed.
2. **The Symbol is module-scoped.** `Symbol('@deepseek-ai/dsh-tools.scheduler')` is a fresh object per module instance, so two instances never agree even though the description matches.
3. **The scope contents are the signal.** A healthy profile scope is links only: the failing one carried 23 real directories against the known-good zero.
4. **Repair has two halves.** Links alone leave the release packages without their own dependencies.
5. **The check detects a constructed fault.** Copying one package into the profile scope as a real directory makes it report failure and exit 1.

## Acceptance criteria

- Verification fails when the two resolvers disagree about one package.
- Verification passes on a deployment whose tool calls work.
- The failure names the package, both resolved paths, and the repair command.
- A missing package on either side reports unknown rather than failing, so the check never blocks a deployment whose layout merely differs.

## Alternatives considered

**Drive a real turn and assert it completes.** Strongest evidence, and what confirmed the repair, but it needs credentials and a model round trip. The identity check is deterministic, offline, and fast enough to run before every restart; the turn belongs in the rehearsal, not in the gate.

**Compare the profile scope against a recorded list of links.** Rejected: it breaks on every legitimate change and cannot tell a missing link from a moved package.

**Rely on `check-profile-scope.mjs`.** Kept, and it answers the adjacent question — whether the scope shadows the release. It reported the profile healthy while a package resolved to two places, so it is a complement rather than a substitute.

## Risks

**One probe package stands for all of them.** `@deepseek-ai/dsh-tools` is the package whose Symbol crosses the process, which makes it the right probe; a divergence confined to another package would not be caught.

**The check can be right while the deployment is wrong.** It rules out one specific cause of failed tool calls, not every cause.
