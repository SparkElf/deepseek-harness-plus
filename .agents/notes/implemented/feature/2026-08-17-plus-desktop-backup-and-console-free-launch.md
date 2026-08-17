# Agent Note: Plus Desktop Backup And Console-Free Launch

Status: implemented

English | [中文](2026-08-17-plus-desktop-backup-and-console-free-launch.zh.md)

## Problem

On Windows, starting Harness from the tray left a persistent `cmd.exe` console window: the Supervisor launched Harness Web through `pnpm dsh web`, pnpm runs package scripts via cmd.exe, and that console hosted the long-lived web server until shutdown. Related tray operations (git probes, taskkill stops, WSL distribution listing) also flashed console windows. Separately, users had no way to export or import their Harness settings and data (`dshHome`: settings, sessions, credentials) for migration or recovery.

## Decision

The Supervisor now launches Harness Web and the development watcher directly: `node --import tsx/esm apps/cli/src/bin.ts web …` from the install root, using PATH-resolved `node`, stdio on the Supervisor log, and `windowsHide: true`. Electron's bundled Node is deliberately not used for this launch because its ESM resolution fails for pnpm symlinked workspace packages. `pnpm` remains only for `pnpm run build`, whose nested script chain is not bypassed. Every desktop-side spawn (Supervisor helpers, installer git/pnpm/wsl execution) sets `windowsHide: true`, so console-subsystem children of the GUI process no longer create windows.

The tray gains a Backup and restore entry that opens a dedicated window with two actions. Export packs the complete `dshHome` directory plus a `backup-manifest.json` marker entry into a zip chosen through the save dialog. Import validates the archive first — the marker must be present and entries with absolute paths, backslashes, or `..` segments are rejected — then stops a running Harness, extracts over `dshHome` with same-named files replaced, and restarts the Harness when it was running, so an invalid archive never leaves the runtime stopped. Missing markers and unsafe paths raise localized errors before extraction. Because `dshHome`'s `settings.yaml` carries the provider and model configuration and `.credentials.yaml` carries the key values themselves, an archive covers the complete user configuration. The window warns that archives contain sensitive data such as API keys. For WSL targets, `dshHome` is accessed through the distribution's `\\wsl.localhost` UNC path, so archives can migrate the complete user configuration — including the key values themselves — between WSL and Windows installations.

## Verification

The Windows NSIS workflow runs the Playwright Electron suite, which now includes a full backup round-trip against a real installed runtime: after the native installation completes, the backup window exports an archive asserted to contain `settings.yaml` and the marker, importing an unrelated zip surfaces the localized rejection and the window recovers, and importing the exported archive restores tampered settings and restarts the running Harness — all driven through the window UI with only the native file dialogs replaced by fixed selections. The round-trip also asserts that the exported `settings.yaml` carries the `agent-default-model` block and that `.credentials.yaml` carries the installer-written key value itself, not just the reference name. Direct node execution additionally covers export/import round-trip, marker rejection, and traversal rejection against a crafted archive.

## Alternatives considered

**Keep launching through pnpm and add only `windowsHide`.** Rejected because `windowsHide` applies to the direct child only; pnpm's cmd.exe grandchild would stay visible for the server's whole lifetime.

**Launch with Electron's bundled Node (`process.execPath`).** Rejected because its ESM loader fails to resolve pnpm symlinked workspace packages during plugin tree load; PATH `node` matches the existing source-launch contract.

**Archive as tar.gz with node:zlib.** Rejected in favor of adm-zip: zip is the expected archive format for users, and adm-zip removes owned serialization code.

**Back up runtime.json or the install tree.** Rejected: runtime.json is machine-local port and path configuration, and the install tree is reproducible from the repository; only `dshHome` is user data.

## Consequences

Starting Harness Web requires `node` on the target PATH, unchanged from the previous cmd-based launch that also resolved `node` from PATH. Import merges by overwrite, so files absent from the archive stay in place; a wipe-and-restore is intentionally not offered. Import stops the runtime before extracting, and a failed import leaves Harness stopped with the error shown in the window.
