---
name: dsh-promote-deployment
description: Use when promoting the running DSH deployment to a new release, building or switching a release mirror, restarting the supervisor that serves it, or diagnosing a deployment that reports a new version while serving old behavior. Covers the mirror build, the profile guard's acceptance step, and the runtime package versions that prove a promotion actually happened.
---

# DSH Deployment Promotion

Use this skill to move a running deployment onto a new release. The deployment is not the repository checkout: it is a **release mirror** under the DSH home, with its own sources, build outputs, and profile. Changing a version in the profile does not change what the runtime executes.

## Find the tools before writing any step

The deployment already owns this procedure. Read these before running anything, and call them rather than re-deriving their contents:

| Command | Owns |
|---|---|
| `dsh-plus-build <mirror>` | `pnpm install` twice (a patch that adds a dependency changes the graph, and only a second install links it), then `pnpm run build --profile official`, then verify the brand record and that no workspace with dependencies lacks `node_modules`. |
| `dsh-plus-switch` | Move the served release to another mirror, tracking phases. |
| `dsh-plus-refresh rebuild \| accept \| restart \| all` | Rebuild the mirror, record the profile as accepted, restart, or all three in that order. |
| `dsh-3080-restart` | Restart through the supervisor: repair profile scope, prove module uniqueness, re-accept the fingerprint, restart, then verify the client modules and the connection surface. |
| `relink-release.mjs --release <mirror>` | Restore the `@deepseek-ai` scope links a `pnpm install` inside the mirror rewrote. |
| `check-profile-scope.mjs --release <mirror>` | Report duplicate `@deepseek-ai` packages and unresolvable dependencies; both break every tool call while HTTP stays 200. |

Writing a second, partial copy of any of these is the mistake this skill exists to prevent. A hand-written promotion that edits only the profile's distribution version reports success, passes an HTTP check, and serves the previous release: the runtime packages resolve from the mirror's sources, which the promotion never touched.

## Promotion order

1. **Build the mirror.** Check out the new official revision in a release mirror, keep the previous mirror as the rollback anchor, apply this repository's patches, then run `dsh-plus-build <mirror>`.
2. **Point the profile at the matching republished packages.** The overrides live in the profile's `pnpm-workspace.yaml`. Two version sequences meet here and they are not the same number: the distribution releases as `0.2.0-rc.N`, while a republished official package carries the official revision it was built from, `0.1.7-rc.1`. Read the range from the version being promoted, never from the installed one — the installed copy names the base being left.
3. **Write the manifest last, after acceptance.** A running supervisor rewrites its manifest on every progress phase — `announce()` calls `writeStatus()`, not only `stop()` — so a manifest written before a multi-second acceptance step is the supervisor's own older copy by the time anything reads it. Measured: the manifest named the new mirror, acceptance ran for seconds, and the reload adopted the previous mirror. `dsh-plus-switch` orders its steps `link → accept → manifest → reload → verify` for this reason.

4. **Record the profile closure.** The supervisor's profile guard refuses to start when the accepted closure changed without a new acceptance. `dsh-plus-refresh accept` does this; a bare restart does not, and the guard then rolls the profile back while the unit retries until `StartLimitBurst` trips, leaving one bare exit code in the journal.
5. **Restart through the supervisor**, not the service manager. The unit runs the supervisor and the web process is its child; `systemctl restart` kills both, so the control socket disappears and every connection is refused during the restart. Use `dsh-3080-restart` or `dsh-plus-refresh restart`.
6. **Verify the runtime, not the distribution version.** See below: this is the step whose absence makes a failed promotion look successful.

## Verify the runtime package versions

The distribution version is a wrapper. What executes is the mirror's own sources, linked into the profile's `@deepseek-ai` scope, so a promotion is complete only when those report the new revision:

```sh
# The mirror's sources, which the profile links to:
cd <mirror> && git rev-parse --short HEAD

# The versions the runtime actually resolves:
for p in dsh-session dsh-tools dsh-host-webserver; do
  node -p "require('<profile>/node_modules/@deepseek-ai/$p/package.json').version"
done
```

Every one must name the new official revision. A distribution version of `0.2.0-rc.N` beside `@deepseek-ai/dsh-tools@0.1.6-alpha.2` is a promotion that changed the wrapper and left the runtime behind, and it will pass an HTTP check and a client-module check while serving the old release.

The mirror also records what it was built from, which is the fastest way to date it:

```sh
node -p "require('<mirror>/.dsh-build/client-build-environment.json').environment"
```

## Diagnose a restart that will not start

Run the checks in the order the interlock runs them, because each answers a question the next cannot:

1. `check-profile-scope.mjs --release <mirror>` — duplicate `@deepseek-ai` packages (two module instances, two scheduler Symbols, every tool call failing with `reading 'prepare'`) and release packages whose dependencies do not resolve. A previous source sync that **moved** rather than copied package `node_modules` trees causes this; `repair-profile-scope.mjs` replaces the shadows with links, and `restore-nested-modules.mjs` brings the nested trees back.
2. `check-plugin-imports.mjs` — every bundle imports.
3. `profile-guard.mjs guard --state <accepted-profile.json>` — the accepted closure still matches.

`preflight-start.mjs` runs all three and repairs what it can; it is the unit's `ExecStartPre`, so a restart issued through the supervisor's runtime command skips it.

## A registry mirror lags the registry

An image or mirror that installs from `registry.npmmirror.com` cannot resolve a release published minutes ago, and the failure names a version that plainly exists — because it does, upstream. Before concluding that packaging is broken, ask both registries:

```sh
curl -s https://registry.npmjs.org/<encoded-name> | grep -c '"<version>"'
curl -s https://registry.npmmirror.com/<encoded-name> | grep -c '"<version>"'
```

Served by the mirror: build. Served upstream only: trigger a sync with `curl -X PUT https://registry.npmmirror.com/-/package/<encoded-name>/syncs`, or point the build at the upstream registry. Served nowhere: the release did not publish, and no retry fixes it.
