---
name: dsh-base-upgrade
description: Use when moving the deployment or a profile onto a new official DSH base version, deciding which plugins are incompatible, repairing them, retiring patches or plugins the new base makes unnecessary, assembling the personal and team editions, publishing a new Plus release, and updating the workspace container. This is the base-first order; do not start from the mirror promotion path.
---

# DSH Base Upgrade, Plugin Repair, And Plus Release

A base bump is six phases, in this order. The process is recorded in
[the base-upgrade Agent Note](../../notes/proposed/process/2026-11-23-base-upgrade-precedes-plugin-repair.md).
This skill is the operational checklist; the note owns the rationale and the rejected alternatives.

The rule that separates this skill from `dsh-promote-deployment`: a new base is proven **bare**
before any Plus patch is built on it, and Plus is published **after** the repaired plugin set is
known. Promoting Plus directly onto the new official tag mixes base compatibility, plugin
compatibility, and patch compatibility in one build, and its failures cannot be attributed.

## Before starting

Record the baseline and keep the served release untouched:

```sh
/root/.dsh/dsh-plus-status --json
readlink -f /root/.dsh/profiles/plus
cat /root/.dsh/supervisor/runtime.json
cat /root/.dsh/supervisor/accepted-profile.json
```

Copy the profile's `package.json`, `pnpm-workspace.yaml`, and `cordis.patch.yml` to a dated backup
directory. Note the current `@sparkelf/dsh-plus` version and the three runtime subjects
(`dsh-session`, `dsh-tools`, `dsh-host-webserver`).

## Phase 1 — Bare base

Use an isolated `DSH_HOME` and a spare port. Do not point this at `/root/.dsh`.

```sh
export DSH_HOME=/root/.dsh/bare-023a2
mkdir -p "$DSH_HOME"
cd "$DSH_HOME"
npm init -y
npm install @deepseek-ai/dsh@0.2.3-alpha.2
node node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3081
```

The first boot creates the `web` profile with `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`
at the installed version. Verify all four, not only the first:

- the process listens on the spare port and answers HTTP;
- the served page mounts its client bundles without a plugin-load error;
- one real turn completes with a tool call;
- the runtime packages report `0.2.3-alpha.2`.

Then mount the candidate bundle set one bundle at a time. A bundle is compatible only when it
resolves, imports, mounts, and survives one smoke interaction. Record every failure with the
bundle name, version, declared peer ranges, exact error, and phase. Remove failures from the
candidate edition; do not add a compatibility exemption to hide them at this phase.

## Phase 2 — Repair incompatible plugins

Repair one plugin at a time in its authoritative source. Confirm the source location before
editing:

```sh
cd /root/projects/dsh-plugins-plus
git ls-files packages/<name> | head
```

Typical repairs:

- a peer range that names only `^0.2.2-rc.N`: widen it to a range that includes
  `0.2.3-alpha.2`, and keep the old versions accepted when they still work;
- a renamed or removed official API: adapt the plugin to the published replacement, never patch an
  official package from the plugin;
- a client slot or settings schema change: update the client half and its locale-owned copy;
- a native dependency: rebuild it for the runtime's Node ABI.

Test by packing and installing the tarball into the bare profile, not by publishing:

```sh
cd /root/projects/dsh-plugins-plus/packages/<name>
pnpm pack --pack-destination /tmp/plugin-packs
cd "$DSH_HOME" && npm install /tmp/plugin-packs/<name>-<version>.tgz
```

A repair that needs a new hook in an official package is a Plus entry, not a plugin change. Route
it through `dsh-plugin-ownership-and-distribution` before implementing.

## Phase 3 — Retire before optimizing

Read the upstream notes and diff:

```sh
cd /root/projects/deepseek-harness-plus
git fetch upstream-official refs/tags/dsh-v0.2.3-alpha.2:refs/tags/dsh-v0.2.3-alpha.2
git log --oneline dsh-v0.2.2-rc.2..dsh-v0.2.3-alpha.2
git diff --stat dsh-v0.2.2-rc.2..dsh-v0.2.3-alpha.2
```

For every entry in `dshPlus.patchSet.entries` and every self-developed plugin, decide one of:

- `retire` — the base now provides the behavior, or `retireWhen` is satisfied;
- `simplify` — the plugin can consume a new extension point instead of its own workaround;
- `keep` — the base does not provide it and the patch is still the minimal carrier;
- `new` — the new base enables a capability worth adding.

A retired patch leaves both `patchSet.entries` and any `patchPackages` or dependency that carried
it. A retired plugin leaves both edition `bundles` and `packages`. Record the upstream identifier
or release note that justifies each retirement in the same change.

## Phase 4 — Publish and assemble editions

1. Bump every package whose payload changed.
2. Build the repository and run the governance gates:
   `pnpm run build && pnpm run verify:plus-governance`.
3. Update `packages/bundle/plus/package.json`:
   - `dshPlus.sourceBase.revision` = `4b399c39a6d1479cd84ca591b4d7c88e24d38a96`;
   - `dshPlus.compatibility.dsh` = `>=0.2.3-alpha.2`;
   - `dshPlus.runtime.version` = `0.2.3-alpha.2`;
   - every republished official dependency and override = `0.2.3-alpha.2`.
4. Assemble `dshPlus.editions.personal` and `dshPlus.editions.team` from the verified versions.
   `intranet-team` follows the same rule because the workspace container installs it.
5. Release: `pnpm run release:ship --family plus --prerelease alpha.N`.
   `release:ship` bumps, publishes, opens the PR, waits for checks, merges with `--admin`, and tags.
6. Prove the registry serves the new `@sparkelf/dsh-plus` and every changed plugin.

Do not hand-edit a generated standalone manifest; there is no standalone distribution after the
0.2.9 model. The profile manifest written by `dsh-plus install` is the install artifact.

## Phase 5 — Install Plus on a bare base

Use a second isolated `DSH_HOME`, not the one from Phase 1.

```sh
export DSH_HOME=/root/.dsh/verify-023a2-personal
mkdir -p "$DSH_HOME"
cd "$DSH_HOME"
npm init -y
npm install @deepseek-ai/dsh@0.2.3-alpha.2
DSH_HOME="$DSH_HOME" node node_modules/@sparkelf/dsh-plus/lib/bin.js install \
  --edition personal --profile personal
DSH_HOME="$DSH_HOME" node node_modules/@deepseek-ai/dsh/lib/bin.js --profile personal web --port 3082
```

Verify the client bundle count, the mounted tools, one real turn, Session recovery, and the
sidebar. Repeat with `--edition team` and a third `DSH_HOME`. A source mirror is not a substitute:
the acceptance test installs from the registry, which is what consumers resolve.

Only after both editions pass does the production deployment move. Use the existing
`dsh-plus-switch`, `dsh-plus-refresh`, and `dsh-3080-restart` procedure for that step.

## Phase 6 — Workspace container

Read `dataops-workspace-image-customization` before editing the image. Update the base and Plus
pins in the workspace image, rebuild it, and run the same bare-install smoke test inside the
container. The host deployment and the container consume the same published artifact but are
verified separately; a green host does not prove the container.

## Failure handling

- A bundle that fails in Phase 1 is removed, not exempted. Exemptions are for published peer
  ranges that the resolver rejects while the code still works; they are not a substitute for a
  mount test.
- A plugin that needs an official change is a Plus entry. Do not add a deployment-time patch.
- A registry that does not serve the new version yet is a propagation wait, not a packaging
  defect. Check both registries before rebuilding.
- A promotion that reports HTTP 200 is not a promotion. Check `dsh-session`, `dsh-tools`, and
  `dsh-host-webserver` versions, as `dsh-promote-deployment` requires.

- **MCP client reads `ctx.root` without inject.** On 0.2.3/Cordis 4.2,
  `@sparkelf/dsh-plugin-mcp-credentials` (and the official `mcp-client`) throws
  "cannot get property root without inject" at `ctx.plugin(McpClient, ...)`. The browser-bridge
  connector then stays `phase=error` while the backend/Companion look healthy. Use
  `scopeOf(ctx) ?? ctx` as the duplicate-serverName owner, publish the plugin, and pin it.
  Details: `dataops/docs/pitfalls-build-and-deploy.md` §88.

## 0.2.3 deployment pitfalls (learned 2026-11-24)

- **Browser auth is required.** `dsh web` prints `?token=`; a bare `/` answers 401 with
  "Connect to this Host". Never treat 401 as down. Exchange the token for the cookie
  (`curl -c jar -b jar '...?token=...'`, then `curl -b jar /`) before probing.
- **Supervisor recovery route.** 0.2.3 defaults web routes to `required`.
  `@sparkelf/dsh-plugin-supervisor` must register `/api/plus-supervisor/recovery` with
  `auth: 'anonymous'` plus a loopback-only socket guard. Without it the supervisor waits at
  `start.launchingWeb` forever and stop/restart appears hung. Fixed in supervisor 0.1.11.
- **Deployment probes.** `dsh-3080-restart`, `dsh-plus-status`, `verify-client.mjs`, and
  `ws-check.mjs` all need the token/cookie. `dsh-plus-status` reads the launch token from
  `/root/.dsh/supervisor/runtime.log` (`grep -a`), exchanges it, then probes with the cookie.
- **Node engine.** 0.2.3 declares `^24.22.3 || >=26.13.1`; both the systemd unit and the
  supervisor manifest's `runtime.command` must point at 24.22.3.
- **Sidebar markers.** `dsh-plus-status`'s old `0/3` marker check is retired at sidebar
  `.22`; report `n/a (.22)` and rely on the client boot and sidebar session rows.

## Related

- `dsh-promote-deployment` — production switch of an already-built Plus release; use only after
  Phase 5 passes.
- `dsh-plugin-ownership-and-distribution` — decide whether a repair belongs in the plugin, a
  fork, or a Plus entry.
- `dsh-repo-release-pr` — repository rules and the `release:ship` sequence.
- `dsh-supervisor-restart` — restart semantics and the profile guard.