# Agent Note: Bundled Package Manager For Plus Desktop

Status: implemented

English | [中文](2026-08-17-bundled-package-manager-for-plus-desktop.zh.md)

## Problem

The packaged Plus Desktop installer spawned pnpm by command name. A normal Windows installation does not guarantee that pnpm is on PATH, so the first install failed with spawn pnpm ENOENT. The same assumption also affected the installed Supervisor's Web start, watcher, upgrade, and repair paths.

## Decision

Plus Desktop declares pnpm 11.7.0 as a production dependency and electron-builder packages its CLI and bundled distribution in app.asar. Native targets execute the packaged pnpm.mjs through the Electron executable with ELECTRON_RUN_AS_NODE=1, so they do not depend on the user's PATH. TargetRuntime owns this invocation for install, upgrade, and repair.

The native Supervisor receives the packaged CLI path through DSH_PNPM_CLI and uses the same invocation for Web, watcher, and build processes. WSL never receives the Windows CLI; TargetRuntime runs corepack pnpm inside the selected Linux distribution and starts the WSL Supervisor with DSH_PNPM_COMMAND=corepack.

## Verification

The bundled resolver runs pnpm 11.7.0 locally without a pnpm command lookup. The Linux directory package contains node_modules/pnpm/bin/pnpm.mjs and node_modules/pnpm/dist/pnpm.mjs inside app.asar. The native Windows workflow is the acceptance gate for the packaged NSIS artifact and its real Electron installer interaction.

## Alternatives considered

**Require users to install pnpm globally.** Rejected because a system installer must own the runtime needed for its first install and must work on a clean Windows PATH.

**Copy a platform-specific pnpm executable beside the installer.** Rejected because pnpm is a Node CLI and the Electron runtime already supplies the matching native Node executable for native targets.

**Run the Windows bundled CLI inside WSL.** Rejected because WSL needs a Linux package-manager process; Corepack resolves pnpm inside the selected distribution instead.

## Consequences

The packaged application is larger by the pnpm distribution, but install, upgrade, repair, Supervisor start, and build no longer depend on a global native pnpm command for native targets. WSL still requires a usable Node/Corepack installation inside the selected distribution and reports its failure there rather than misusing a Windows executable.
