# Agent Note: Web Settings Backup Section Over The Host Backup RPC Pair

Status: implemented

English | [中文](2026-08-18-web-settings-backup.zh.md)

## Problem

The web GUI offered no way to export or import the user settings and data: the desktop tray backup covers installed Windows users, but browser users of the 3080 runtime had no archive path for migration or recovery, and no settings surface naming the operation.

## Decision

The settings dialog gains a `backup` section (`settings.section` slot, new plugin `@deepseek-ai/dsh-client-ui-settings-backup`) that exports the user settings and data as one zip archive (browser download) and imports such an archive back. The archive contract mirrors the desktop tray backup ([2026-08-17-plus-desktop-backup-and-console-free-launch](2026-08-17-plus-desktop-backup-and-console-free-launch.md)): a `backup-manifest.json` marker identifies real backups; runtime-generated `profiles` and `supervisor` directories are excluded; import validates the marker and every entry path (no absolute, backslash, `..`, or empty segments) before mutating anything; restore extracts over the harness home with same-named files replaced. The zip core lives in `dsh-host-apiproxy` beside the settings wire face and rides its existing `fflate` dependency; the archive crosses the loopback RPC base64-encoded. The two notes stay active, one per surface.

## Alternatives considered

**A separate host package for the backup core.** Rejected: the settings domain already owns the loopback wire face, and two methods on it keep one gateway, one schema table, and one client face instead of a fourth registration surface.

**Streaming HTTP download/upload routes.** Rejected: user-data-scale archives fit base64-over-RPC, and reusing the unary carrier pair avoids a second transport contract in the fetch handler and client.

## Consequences

- Archive size is bounded by browser and Host memory (base64 over JSON).
- Import restores files but does not restart a separately managed desktop runtime; the web Host re-reads settings live.
- The desktop tray backup stays as-is; both surfaces share the contract but not code (the desktop app packs through adm-zip, the Host through fflate).

## Verification

- `packages/host/apiproxy/tests/backup.spec.ts`: round-trip, marker rejection, traversal/absolute/backslash/empty-segment rejection, generated-directory exclusion, symlink skip, same-name overwrite with unrelated files kept.
- `packages/client/ui-settings-backup/tests/backup-section.client.spec.tsx`: export download trigger, localized rejection mapping, import success and rejection, busy-state disabling, no-file picker change ignored.
- `apps/web/tests/settings-backup.e2e.ts`: UI-driven closed loop against the real Host — export through the section, assert archive entries and marker, tamper the harness home, import the archive through the file input, assert restoration; marker-less archive rejected with localized copy.
