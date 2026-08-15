# Agent Note: Independent runtime supervisor

Status: proposed

English | [中文](2026-08-14-independent-runtime-supervisor.zh.md)

## Problem

The desktop tray must control a Harness Web process that can rebuild and restart the installed worktree without depending on the tray's direct child process or the shell that requested the action.

## Proposal

A detached Supervisor owns the configured Web process, optional client watcher, configured port, and rebuild lifecycle. The Electron tray is a client of a local Unix socket or Windows named pipe. The manifest is the source of runtime identity and records the explicit worktree, DSH_HOME, port, mode, branch, revision, dirty state, phase, and child PIDs.

The Supervisor owns port takeover for its configured runtime. It stops an existing listener only when its PID matches the recorded Web PID, unless the manifest explicitly sets <code>allowPortTakeover: true</code> for a deliberate external handoff. It confirms that the port is released after graceful and forced termination, builds the recorded worktree, and starts Web with the recorded environment. It does not infer a branch or DSH_HOME from the caller's cwd.

One non-status lifecycle command owns the runtime at a time; concurrent lifecycle commands fail without changing its state. It streams language-neutral phase keys and values before its final response. The same structured phase is persisted in the manifest and runtime log. The progress page reads the configured DSH_HOME locale preference and renders both current and historical phases in that language; the tray and command-line client consume the same event stream.

## Ownership map

| Area | Owner | Responsibility |
| --- | --- | --- |
| Runtime process | <code>apps/plus-desktop/src/supervisor.mjs</code> | IPC, source identity, port takeover, process groups, build, watcher, progress, and logs. |
| Desktop client | <code>apps/plus-desktop/src/daemon.mjs</code> | Launch or connect to the detached Supervisor and expose lifecycle status to Electron. |
| User-facing tray | <code>apps/plus-desktop/src/main.mjs</code> | Persist manifest paths and expose start, stop, and rebuild-and-restart actions. |
| Command-line client | <code>apps/plus-desktop/src/supervisor-client.mjs</code> | Print progress events and the final status for manual recovery and diagnostics. |
| Progress page | <code>apps/plus-desktop/src/supervisor-progress-server.mjs</code> and <code>apps/plus-desktop/progress</code> | Render the Supervisor event stream, persisted history, raw runtime output, controls, icons, and configured locale. |
| Explicitly untouched | Harness Web RPC, agent-loop, Settings, and session persistence | No product protocol or durable session format changes. |

## Progress contract

A command emits zero or more structured phase messages followed by exactly one success or failure response on the same local connection. A phase has a stable key and JSON values; the Supervisor never stores a localized phrase. The page resolves phase text with the configured locale and retains it in the runtime log as structured history. Raw process output is stored separately and displayed without translation. Failures are logged with the original error object and return a concise error to the client.

## Acceptance criteria

- The tray does not directly own the Web child.
- A Supervisor started independently can report its exact source path, branch, revision, DSH_HOME, mode, port, phase, and child state.
- <code>rebuild-and-restart</code> can retake a listener with the recorded Web PID, or an explicitly allowed external listener, build the recorded worktree, and wait for Web readiness.
- A command-line client displays progress while a long build is running.
- The local progress page updates phase and raw build output during a running command, retains phase history after refresh, and follows <code>locale.preference</code>.
- Client HMR is supervised only in development mode; production rebuilds use build plus restart.
- Supervisor teardown waits for managed child processes to exit.

## Risks

An explicit <code>allowPortTakeover</code> setting can stop an unrelated process if a manifest points at another application's port. The default path only retakes the recorded Web PID and refuses an unknown owner. A dirty worktree remains visible in status so callers can review the exact source state before rebuilding.

## Alternatives considered

Keeping the Web child under Electron leaves restart ownership coupled to tray lifetime. Letting the agent shell spawn the child leaves the process coupled to tool cancellation. A persistent progress file without a socket stream would help diagnosis but would not update the tray during a rebuild. The detached Supervisor plus local progress stream keeps one lifecycle owner and gives both interactive clients the same phase source.
