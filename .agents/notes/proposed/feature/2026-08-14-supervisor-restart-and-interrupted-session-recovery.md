# Agent Note: Supervisor restart and interrupted-session recovery

Status: proposed

English | [中文](2026-08-14-supervisor-restart-and-interrupted-session-recovery.zh.md)

## Problem

Directly restarting Harness Web bypasses the desktop Supervisor's port ownership, branch identity, progress log, and takeover checks. A restarted Web page also stays on the old document until the user refreshes it. If a turn was running when the Web process disappeared, the new page has no recovery action. The settings page hides its document action when a document exists but the current Linux runtime has no desktop opener.

## Proposal

The Supervisor progress API accepts a command and target branch. The target branch is accepted only by <code>rebuild-and-restart</code>; an unscoped <code>restart</code> operates only on the branch already reported by Supervisor status. The request crosses the existing local Supervisor socket; HTTP never starts or kills Web directly. A target must be an existing local branch. A clean worktree may switch branches; a dirty worktree may only continue on its current branch. Same-branch dirty rebuilds are valid for aggregation-branch acceptance. Operation and runtime status report the requested branch, actual branch, revision, dirty state, Web PID, and completion phase.

The existing client-HMR EventSource keeps plugin-only rebuilds in place. After its first successful open, an SSE disconnect followed by a reconnect means the Web runtime was restarted; the browser arms recovery and performs one whole-page reload. The first open and repeated open events do not reload.

Before connection state is discarded, client runtime stores session ids whose Host summaries are running. After the HMR reload, the new runtime refreshes the session list and sends this queued prompt through each retained SessionFace: <code>请继续完成任务，如果都已完成则回复没有未完成的任务即可</code>. Accepted prompts remove their ids; missing sessions, refresh failures, and rejected prompts remain pending. The prompt uses the existing Host API, session log, and normal agent execution.

The settings-general header action is registered whenever Host metadata reports a local document. When <code>canOpenDocument</code> is false, the action stays visible but disabled with a tooltip explaining that the current runtime cannot invoke a desktop application. It never claims native open support from <code>hasDocument</code> alone.

## Ownership map

| Surface | Owner | Change |
| --- | --- | --- |
| Supervisor | <code>apps/plus-desktop/src/supervisor.mjs</code>, <code>supervisor-progress-server.mjs</code> | Branch-scoped lifecycle and progress identity. |
| Progress UI | <code>apps/plus-desktop/progress</code> | Fixed scrolling panels, unified branding, classified logs, branch command payload. |
| HMR client | <code>packages/client/hmr</code> | Detect runtime reconnect and reload once. |
| Session runtime | <code>packages/client/runtime</code> | Capture running sessions and send recovery prompts after reload. |
| Settings UI | <code>packages/client/ui-settings-general</code> | Preserve visible but disabled document action when no native opener exists. |
| Reused | Existing settings API, SessionFace prompt, session log, Cordis loader | No new transport or agent execution path. |
| Untouched | <code>packages/core/agent-loop</code>, Host session wire contract, normal tool lifecycle | Existing extension points remain authoritative. |

## Alternatives considered

**Restart Web directly from a shell.** Rejected because it bypasses Supervisor branch and port ownership.

**Reload after every plugin rebuild.** Rejected because plugin-only HMR is already page-preserving and full reload would discard unnecessary UI state.

**Call agent-loop directly for recovery.** Rejected because the existing SessionFace prompt API already records a normal user turn and owns admission, persistence, and execution.

## Acceptance criteria

- A branch-scoped rebuild/restart completes on <code>review/all-prs</code> and reports that branch in operation and runtime status.
- Plugin-only HMR keeps page identity; Supervisor Web restart reloads the page once.
- Sessions running before the restart receive one durable queued recovery prompt after reload; rejected prompts remain recoverable.
- A configuration document action remains visible and is disabled honestly when no native opener is available.
- Agent loop and Host session protocol remain unchanged.

## Risks

Cross-branch switching is refused on a dirty worktree. A session that completed immediately before disconnect may receive the conservative recovery prompt and answer that no work remains. Recovery candidates are browser session storage state for the same origin. Headless Linux cannot enable native file opening without a desktop opener supplied by the shell.
