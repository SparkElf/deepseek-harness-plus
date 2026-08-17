# @deepseek-ai/dsh-client-ui-settings-backup

English | [中文](README.zh.md)

Settings Backup section: the `backup` page of the settings dialog exports the user settings and data as one zip archive (browser download) and imports such an archive back. Archive bytes stream over the loopback-only Host routes `/api/backup.export` (single-use token download) and `/api/backup.upload` (body streamed to a temp file); the RPC pair (`settings.backupExport` / `settings.backupImport`) carries only the download URL and the upload token, never archive content. The archive contract — manifest marker, runtime-generated directory exclusion, zip-slip validation before mutation, same-name overwrite — lives with its implementation in `dsh-host-apiproxy`; this package renders the page and localizes its status.

## Model Experience

None, as the plugin renders browser settings UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- Import restores files under the harness home but does not restart a separately managed desktop runtime; the web Host re-reads settings live.
- The archive travels base64 over the loopback RPC, so archive size is bounded by browser and Host memory; runtime-generated `profiles` and `supervisor` directories are neither exported nor restored.
