# Agent Note: Web Backup Streaming Transport Replaces Base64-Over-RPC

Status: implemented

English | [中文](2026-08-18-web-backup-streaming-transport.zh.md)

## Problem

The initial web backup transport embedded the zip archive as base64 inside the JSON RPC reply and request. A 150 MB harness home produced a ~190 MB base64 string on the Host plus JSON envelope copies, and the browser duplicated it again through `atob` and the Blob, so clicking 导出备份压缩包 exhausted memory on both ends of the wire.

## Decision

Archive bytes no longer ride the JSON wire. `settings.backupExport` writes the zip to a Host temp file and answers a single-use `/api/backup.export?token=…` URL; the carrier streams the file as a zip attachment through the host-only `backups` domain, the mirror of `downloads`. Import streams the picked file to a temp file through the loopback-only exact route `/api/backup.upload` (2 GiB ceiling), and `settings.backupImport` consumes the upload token, validates, and restores. Both routes are pinned to loopback like the rest of the settings plane. This supersedes the base64 choice recorded in [2026-08-18-web-settings-backup](2026-08-18-web-settings-backup.md); the archive contract (manifest marker, `profiles`/`supervisor` exclusion, zip-slip validation before mutation, same-name overwrite) is unchanged.

## Alternatives considered

**Keep base64 and raise body caps.** Rejected: the memory multiplication is inherent to the encoding on both sides, not to the cap.

**Chunked RPC transfer.** Rejected: the webserver's exact-route registry plus node streaming delivers the same property with no new protocol.

## Consequences

- Host memory peaks at one zip buffer; the browser never holds the archive as a string.
- Tokens are single-use and expire after ten minutes; temp directories are swept on consumption, expiry, and restore completion.

## Verification

- `apps/web/tests/settings-backup.e2e.ts` drives the streaming download (Playwright download event against the token URL) and the streaming upload (file input posting to the upload route) with unchanged archive-content and restore assertions.
- `packages/host/apiproxy/tests/backup.spec.ts` covers the zip core over byte buffers.
