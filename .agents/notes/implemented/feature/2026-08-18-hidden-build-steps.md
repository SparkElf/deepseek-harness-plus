# Agent Note: Hidden Build Steps Replace pnpm For Supervisor And Installer Builds

Status: implemented

English | [中文](2026-08-18-hidden-build-steps.zh.md)

## Problem

`pnpm run build` spawns nested lifecycle children (npm, cmd) that Windows gives visible console windows — `windowsHide` only reaches the direct child — so every Supervisor or installer build popped a blank terminal that stayed open for minutes while the real output went to the Supervisor log and installer progress bar.

## Decision

`hiddenBuildSteps` lists the root build's five stages — `tsc -b tsconfig.host.json`, `tsdown --env.DSH_BUILD_FACE host`, `tsc -b tsconfig.client.json`, `tsdown --env.DSH_BUILD_FACE client`, and `vite build` under `apps/web` — and the Supervisor plus the installer/upgrade/repair flows run each stage directly through `node` with `windowsHide`, bypassing the package manager. WSL targets reuse the same steps with posix joins. This supersedes the "pnpm remains only for build" choice in [2026-08-17-plus-desktop-backup-and-console-free-launch](2026-08-17-plus-desktop-backup-and-console-free-launch.md); pnpm still serves dependency installs.

## Alternatives considered

**Keep pnpm and hide its grandchildren.** Rejected: the grandchildren are spawned inside pnpm without `CREATE_NO_WINDOW`, and every console-subsystem child of a console-less parent gets a fresh visible console; no flag on our direct child reaches them.

**Wrap the build in `cmd /c`.** Rejected: same grandchild problem one hop deeper.

## Consequences

- Build output keeps streaming to the Supervisor runtime log and the installer progress line; no terminal window appears on any build path.
- The step list duplicates the root `build` script's stages; a script change must update `hiddenBuildSteps`.

## Verification

- The Windows CI Electron suite performs full installations whose build phase runs through the hidden steps (cases 2 and 3 of `installer-electron.spec.mjs`).
- Supervisor `rebuild-and-restart` on the Linux host uses the same steps.
