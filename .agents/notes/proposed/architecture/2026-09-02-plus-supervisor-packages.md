# Agent Note: Plus Supervisor and Desktop npm packages

Status: proposed

English | [中文](2026-09-02-plus-supervisor-packages.zh.md)

## Problem

The npm Plus distribution materializes official DSH and Plus-owned packages, but no published owner spans a controlled Web process restart. A Session running when the process stops retains durable history but receives no new turn after the replacement process starts. The former Desktop application combined source installation, Electron presentation, process supervision, and browser-based recovery, so restoring it as one application would recreate a second distribution path beside the npm profile.

## Decision

Plus ships two independently owned npm packages. <code>@sparkelf/dsh-plugin-supervisor</code> contains the Host Cordis entry, a plain Node Supervisor executable, its local command client, and the progress page. <code>@sparkelf/dsh-plus-desktop</code> contains only the optional tray function consumed by an Electron host and depends on the Supervisor package. The distribution package materializes Supervisor and mounts its Host entry; it does not depend on Desktop.

The Supervisor manifest names the already materialized runtime command, arguments, working directory, DSH home, Web port, Supervisor port, local socket, and optional build command. Supervisor neither clones a repository nor selects a source branch. Desktop reads that manifest, starts Supervisor when needed, delegates every command, and leaves both Supervisor and Harness running when Desktop exits.

A controlled restart is one ordered operation. A rebuild completes while the old Web process remains available. Supervisor then calls the Host entry to capture ids of running top-level Sessions, stops the old process, starts the manifest command, waits for its Web port, and submits one queue prompt for each captured id through <code>SessionController.prompt</code>. The prompt tells the model to inspect durable history, workspace state, and tool results, avoid repeating completed operations, finish remaining work, and reply <code>已完成</code> when no work remains. Capture or recovery failure is reported by the same Supervisor operation. Recovery is always active for Supervisor restarts and has no configuration switch.

Ordinary start, stop, process crash, network reconnect, and client HMR do not trigger recovery. The Host message uses the existing user-message log path, so no Session event or agent-loop branch is added.

## Package ownership

| Package | Ownership |
|---|---|
| <code>@sparkelf/dsh-plus</code> | Materializes and composes the Supervisor package with official DSH and the other Plus packages. |
| <code>@sparkelf/dsh-plugin-supervisor</code> | Host capture/recovery entry, external process lifecycle, command socket, manifest, runtime log, and progress page. |
| <code>@sparkelf/dsh-plus-desktop</code> | Optional tray presentation and delegation to the Supervisor command client. |
| Official Session Controller | Lists running Sessions, resumes cold Sessions, admits the logged recovery user message, and queues its turn. |

## Alternatives considered

**Restore the former Desktop tree unchanged.** Rejected because its Git clone, branch switch, dependency installation, and source build flow would duplicate the npm materializer.

**Implement recovery as an official-source patch.** Rejected because the official Session Controller already exposes the operations the Plus capability needs.

**Keep recovery in browser HMR.** Rejected because browser connectivity does not own the process restart and an absent browser could not recover work.

**Keep Desktop and Supervisor in one package.** Rejected because npm-only Plus must supervise a runtime without installing Electron, while Desktop presentation remains optional.

## Verification

One Plus system path starts a materialized runtime through Supervisor, submits work in Harness Web, triggers restart from the Supervisor progress page while the Session is running, and observes the retained recovery message and resumed turn in the same Session. The same path verifies that the progress page reports captured, recovered, and failed counts.
