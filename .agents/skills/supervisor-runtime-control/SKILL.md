---
name: supervisor-runtime-control
description: Mandatory gate for every local DeepSeek Harness development change: use production HMR only for an explicitly eligible pure client-plugin edit; otherwise edit and validate an isolated 3081 candidate before a user-authorized 3080 promotion through the systemd-managed Supervisor.
---

# Supervisor Runtime Control

Use the platform service manager and Supervisor as the only owners of Harness Web processes. Never run <code>kill</code>, <code>pkill</code>, <code>pnpm dsh web</code>, or a replacement Web server while a Supervisor owns that runtime.

## Mandatory Development Gate

Apply this gate before editing a runtime source file, starting a test server, or issuing a Supervisor command. There are only two paths:

1. A pure client-plugin source edit may use production HMR only after the production Supervisor reports an active watcher PID and every changed runtime file is inside a client-plugin bundle.
2. Every other change must use a new or existing candidate branch in a separate worktree. Edit, build, and verify it only through candidate ports 3081 and 3083.

The 3080 production worktree is not a non-HMR development workspace. It may only serve the current accepted runtime, report status, and receive a promotion after the user explicitly accepts the candidate. A successful local build does not substitute for candidate acceptance.

## Choose one mode

### Sole exception: HMR in the production worktree

Use HMR only when every changed runtime file belongs to a client plugin bundle and the production Supervisor reports an active watcher PID. Source-only client plugin JavaScript, TypeScript, and CSS changes qualify.

The Web shell, client runtime, HMR infrastructure, Host, Supervisor, desktop process, settings/schema, dependency, lockfile, bundle composition, and built artifacts do not qualify. Tests and documentation do not become runtime-HMR changes merely because they sit beside a client plugin.

HMR uses the production install path and current branch reported at <code>http://127.0.0.1:3082</code>. It does not create or switch a branch or worktree. If the watcher is not active, start it through the production control socket and confirm the page reports its PID before editing client-plugin source.

### Candidate runtime for non-HMR changes

Use a candidate branch in a separate Git worktree for every non-HMR change. The branch is the version line; the worktree is the only place that change may be edited, built, and tested before acceptance. Never switch or edit the production worktree to prepare candidate testing.

The candidate owns:

- its branch and worktree directory;
- an isolated DSH_HOME containing only the configuration required for the candidate;
- Web port 3081;
- progress page port 3083;
- a candidate control socket and runtime log;
- one transient systemd service.

Create or select the branch before adding the worktree. Run the repository install in that worktree when its dependency links are absent. Write its Supervisor manifest with <code>installPath</code>, candidate <code>dshHome</code>, <code>port: 3081</code>, <code>progressPort: 3083</code>, and <code>mode: code</code>. Start it with <code>systemd-run</code> using the absolute Node executable, the candidate Supervisor source, its manifest, its socket, the candidate worktree as <code>WorkingDirectory</code>, <code>Restart=on-failure</code>, and <code>KillMode=process</code>.

The unit name uses a short local candidate id; it is not a source identity. The branch name remains the only promotion target. If `systemd-run --user` fails because this host has no user bus, use one DSH-managed background job as the candidate Supervisor owner instead: run the same absolute Node command with `exec`, retain its job id, and do not use shell `&`, a detached child, or the production Supervisor as a fallback. This exception applies only to candidate ports and candidate state.

Open the candidate page at <code>http://127.0.0.1:3083</code>, build and start it there, then complete the real user workflow at <code>http://127.0.0.1:3081</code>. Commit accepted candidate changes locally before production promotion so the production worktree can switch to the branch. Do not push or create a PR before user acceptance.

## Promote a candidate branch

Only after the user explicitly accepts the candidate at <code>http://127.0.0.1:3081</code>, open <code>http://127.0.0.1:3082</code>, enter the candidate branch in Target branch, and choose Build and restart. The production Supervisor performs this sequence:

1. switch the production worktree to the target branch;
2. run the branch build while the current 3080 Web process remains available;
3. stop the current Web process only after the build succeeds;
4. start the replacement on 3080;
5. report the current branch and completion through SSE.

The selected branch's latest local content is the promoted content. Do not record, send, or compare a commit hash for promotion. The <code>branch</code> field is accepted only by <code>rebuild-and-restart</code>; an unscoped <code>restart</code> is limited to the branch already reported by Supervisor status.

A failed build leaves the preceding 3080 Web process running. Read the concise failed operation on the page and the complete raw compiler output in Runtime log. Do not manually stop Web and do not resend an interrupted command; reconnect to the page and read the persisted operation outcome.

## Finish and clean up

After a successful Supervisor restart, observe the existing <code>http://127.0.0.1:3080</code> page reload automatically. A page that was connected to a running session stores that session id before the disconnect and, after reload, sends the durable queued recovery prompt through the existing session API. Complete user acceptance only after the reloaded page reconnects and the recovery prompt is visible in every previously running interrupted session. Stop the candidate systemd unit after production acceptance. Remove the candidate worktree only when it has no uncommitted files. Push the accepted branch and create or update its PR only after local acceptance; never merge it automatically.
