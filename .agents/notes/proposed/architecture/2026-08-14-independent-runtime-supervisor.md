# Agent Note: Independent runtime supervisor

Status: proposed

English | [中文](2026-08-14-independent-runtime-supervisor.zh.md)

## Problem

The desktop tray must control a Harness Web process that can rebuild and restart the installed worktree without depending on the tray's direct child process or the shell that requested an action. Developers also need a fast HMR path for eligible client-plugin changes and an isolated path for changes that require a new Web process.

## Proposal

The current developer deployment uses systemd to keep the production Supervisor independent of agent shells. A packaged desktop installation instead starts one detached Supervisor through Electron in its selected native or WSL target. In both deployments, that Supervisor owns the production Web runtime, its private local socket or named pipe, and the HTTP/SSE control page; the page is part of the Supervisor process, not a separate helper.

A desktop installation selects one runtime target. Native installations execute directly on the host. A Windows-hosted WSL installation executes its checkout, files, Git and pnpm commands, Supervisor, Web process, watcher, and process lifecycle inside the selected distribution. <code>TargetRuntime</code> owns this difference; Electron remains the tray and browser handoff process. The Windows tray invokes the WSL Supervisor client inside that distribution rather than interpreting Linux paths, PIDs, or Unix sockets.

The branch name is the deployment target. Promotion does not accept or compare a commit hash; the manifest may display the current revision for source diagnostics. A branch-scoped production command switches to the requested local branch, builds that branch, and stops the current Web process only after the build succeeds. A build failure leaves the current 3080 Web process running and reports the concise failure state plus raw build output.

## Runtime modes

### HMR

A source-only change in a client plugin uses the current production worktree and its active <code>pnpm run dev:web</code> watcher. HMR is not available for the Web shell, client runtime, Host, Supervisor, desktop process, settings/schema, dependency, lockfile, bundle composition, or built artifact changes.

### Candidate runtime

A non-HMR change uses a separate Git worktree on its candidate branch. A systemd transient service owns its isolated DSH_HOME, 3081 Web runtime, and 3083 candidate control page. The production 3080 runtime continues to use its own worktree and data directory. The production control page may report candidate status, but one Harness runtime does not connect to or observe the other.

### Promotion

After browser acceptance on 3081, the production Supervisor receives <code>rebuild-and-restart</code> with the candidate branch name. It switches the production worktree to that branch, builds it, and only then stops the production Web process, releases its configured port, starts the replacement, and reports completion on 3082. The branch's latest local content is the promoted content.

## Ownership map

| Area | Owner | Responsibility |
| --- | --- | --- |
| Developer production service | systemd | Keep the current developer Supervisor alive independently of agent shells. |
| Packaged production service | Electron desktop manager | Start one detached Supervisor in the selected native or WSL target. |
| Runtime process | <code>apps/plus-desktop/src/supervisor.mjs</code> | IPC, branch activation, source identity, port takeover, process groups, build, watcher, progress, and logs. |
| Progress page | <code>apps/plus-desktop/src/supervisor-progress-server.mjs</code> and <code>apps/plus-desktop/progress</code> | Serve 3082 from the Supervisor process and render branch, phase, history, and raw output. |
| Candidate service | systemd transient service | Own the candidate worktree, DSH_HOME, 3081 Web runtime, and 3083 page. |
| Runtime target | <code>apps/plus-desktop/src/target-runtime.mjs</code> | Execute target files, commands, Supervisor launch and control in the selected native host or WSL distribution. |
| Desktop client | <code>apps/plus-desktop/src/daemon.mjs</code> | Connect to the target Supervisor and expose lifecycle status to Electron. |
| Explicitly untouched | Harness Web RPC, agent-loop, Settings, session persistence, providers | No product protocol or durable session format changes. |

## Progress contract

One non-status lifecycle command owns a runtime at a time. It streams language-neutral phase keys and values before its final response. The Supervisor persists those phases and raw process output. The page resolves structured phases with the configured locale. The phase failure message is concise; the runtime log remains the source for complete compiler and build output.

## Alternatives considered

**Stopping 3080 before branch activation and build.** A failed build then leaves no usable runtime for the user.

**Using a commit hash as the promotion target.** The accepted workflow promotes the latest content of the selected branch, so a branch name is the only deployment identifier.

**Making 3080 Harness observe 3081 Harness.** Runtime-to-runtime observation couples independent data, session, and process lifecycles. The Supervisor control plane owns cross-runtime visibility instead.

## Acceptance criteria

- systemd keeps the current developer Supervisor and its 3082 page alive when an agent tool invocation ends; a packaged desktop installation starts its detached Supervisor in the selected target.
- A WSL installation keeps source, configuration, processes, lifecycle commands, and Supervisor state in the selected distribution while the Windows tray opens its loopback pages.
- HMR is used only by an active client-plugin watcher in the production worktree.
- Candidate branch testing uses a separate worktree, DSH_HOME, 3081, and 3083.
- A branch-scoped production rebuild switches the branch, completes the build, then stops and starts 3080.
- A failed branch build leaves the preceding 3080 Web process running and presents the failure without persisting full raw output in the manifest phase.
- Browser acceptance refreshes 3080 after a completed production promotion.

## Risks

A branch is mutable by design, so promotion intentionally runs the latest local content of that branch rather than a historical candidate commit. A production branch switch changes source files before its build finishes; candidate testing and a build-first process lifecycle preserve the running Web process, but do not provide immutable artifact deployment. An explicit <code>allowPortTakeover</code> setting can stop an unrelated process if a manifest points at another application's port; the default path only retakes the recorded Web PID and refuses an unknown owner.
