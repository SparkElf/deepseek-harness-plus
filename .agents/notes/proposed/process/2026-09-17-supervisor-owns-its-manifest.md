# Agent Note: Stop the supervisor before editing the manifest it owns

Status: proposed

English | [中文](2026-09-17-supervisor-owns-its-manifest.zh.md)

## Problem

Promoting 3080 from the rc.28 mirror to rc.29 looked like it had failed three times. Each attempt edited `/root/.dsh/supervisor/runtime.json` to name the new mirror's entry, restarted `deepseek-harness-plus.service`, and came back answering 200 — while the web process still ran `plus-rc28`.

The manifest and the running process disagreed, and the manifest kept reverting:

```
runtime.json: /root/.dsh/releases/plus/plus-rc29/apps/cli/lib/bin.js
web process:  /root/.dsh/releases/plus/plus-rc28/apps/cli/lib/bin.js --profile plus --port 3080
```

## Why it reached production

**The supervisor caches its manifest and writes it back on stop.** `readSupervisorManifest` runs once at start; every later write uses that in-memory copy:

```js
// runtime/supervisor.mjs
async stop() {
  ...
  this.writeStatus()          // serializes THIS.MANIFEST, not the file
}
writeStatus() {
  const content = JSON.stringify({ ...this.manifest, state, webPid, phase })
  writeSupervisorManifest(this.manifestPath, content)
}
```

So an edit made while the service runs is discarded by the stop that follows it. The order was wrong, not the edit: edit → restart lets the stop overwrite the change, and the start then reads the value it just restored.

**The restart loop hid the cause.** Each attempt reported a healthy 200 because the *previous* mirror answered the port. Nothing in the sequence compared the requested mirror with the served one, so three attempts produced three green health checks and no promotion.

**The runbook names the steps but not the order's constraint.** Its step 7 says to capture sessions and switch the profile atomically; the atomicity that matters here is stopping before editing the manifest, which no step states.

## A later measurement: every phase writes, not only stop

Promoting to `0.1.7-rc.1` reproduced this with a different trigger. `dsh-plus-switch` wrote the
manifest, then ran `profile-guard accept` — which takes seconds while the supervisor is still
serving — and the reload that followed adopted the *previous* mirror:

```
reload.adopting  from=.../plus-rc30/apps/cli/lib/bin.js  to=.../plus-rc30/apps/cli/lib/bin.js
```

The writer is `announce()`, not merely `stop()`:

```js
announce(key, values = {}) {
  this.phase = { key, values }
  ...
  this.writeStatus()          // every progress phase serializes the in-memory manifest
}
```

A supervisor that is still running therefore rewrites the file on any progress phase, so the
window between writing and reading the manifest is not safe while the unit is active. The
sequence that holds is **accept first, write the manifest last**, immediately before the reload
that reads it; `dsh-plus-switch` now orders its steps `link → accept → manifest → reload →
verify` for that reason.

## Proposal

**Stop the process that owns a file before editing it, and verify the served artifact rather than the command's exit status.**

`dsh-plus-switch` performs the sequence in the order the constraint requires:

1. Stop the unit and wait for it to leave `active`.
2. Point `profiles/plus` at the new mirror.
3. Edit `runtime.json` — only now, when no supervisor holds a copy.
4. Record the accepted profile with `profile-guard accept`.
5. Start, wait for the port, then **compare the mirror the web process runs with the mirror that was requested**, failing when they differ.

Step 5 is the one whose absence made the failure invisible. A health check answers "is something serving", which a stale mirror satisfies.

## Findings this change rests on

1. **The supervisor reads its manifest once.** `bin.mjs` calls `readSupervisorManifest(args.manifest)` at start; `startWeb` spawns with `this.manifest.runtime.command` and `this.manifest.runtime.args`.
2. **`stop()` writes that cached copy back.** Measured: with the service running and `runtime.json` naming plus-rc29, `systemctl stop` left the file naming plus-rc28 again.
3. **A stale mirror answers the health check.** Three restarts each returned 200 from the process started from the previous manifest.
4. **The profile guard accepted each change.** Its log line recorded `acceptedProfile` moving to plus-rc29 well before the web process did, so the guard was not the blocker.
5. **The mirror path appears in the entry argument and the cwd, not in the flags.** Only `args[0]` and `cwd` name the mirror; rewriting the remaining arguments by pattern would tie the script to their current spelling.
6. **The served profile is readable from the process list.** `ps -eo args` shows the entry path of the web process, which is what the verification step compares against the requested mirror.

## Acceptance criteria

- Switching mirrors with the service running and restarting does not leave `runtime.json` naming the previous mirror.
- `dsh-plus-switch <mirror>` exits non-zero when the web process after the restart is not the requested mirror, and its message names both.
- After a successful switch, `profiles/plus`, `runtime.json`, and the web process all name the same mirror.

## Alternatives considered

**Edit `runtime.json` and call `systemctl restart`.** Rejected: the stop writes back the cached manifest, so the edit is lost and the restart is a no-op that reports success.

**Stop, edit, start, and trust `systemctl`'s exit status.** Rejected: the start succeeds whichever manifest it read; three attempts passed this way while serving the old mirror.

**Set the runtime path through an environment variable the supervisor reads each start.** Rejected for now: the manifest is the supervisor's documented input, and a second source of truth would need its own precedence rule.

## Risks

**The switch stops the service, so a failed start leaves 3080 down.** The script waits for the unit to answer before reporting success, and a failure names the port, but recovery is manual. A caller that cannot tolerate the gap should target a separate instance first.

**The verification reads the process list.** A deployment that runs the web process under a different argument spelling would fail a correct switch; the pattern matches the entry path this deployment uses.