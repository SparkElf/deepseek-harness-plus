# Agent Note: Plus Backup as one full-stack plugin

Status: proposed

English | [中文](2026-08-30-plus-backup-plugin.zh.md)

## Problem

The accepted Plus runtime exports and restores the complete user data home with streamed progress, bounded disk-backed upload, archive validation before mutation, Workspace and Session cache restoration, cancellation before mutation, retry after failure, and one browser reload after success. That behavior currently spans the old Host ApiProxy, Connection package, Workspace private code, a Client-only settings package, and Web Bundle rows. Official DSH `dsh-v0.1.2-alpha.1` has the public WebServer and Connection trust operations needed by an external Host plugin, but it has no public Workspace operation that closes durable storage around an external restore and then rebuilds live indexes. Developing against the old Connection API would require a compatibility adapter and preserve the wrong source base.

## Proposal

Develop Backup only on the official tag in an isolated worktree. Publish one `@sparkelf/dsh-plugin-backup` package from `packages/plus/backup`; its Host and Client entries form one capability and its npm closure contains every runtime dependency. The archive operation selects `all | configuration | sessions`: all is the union of the other two, configuration owns the active Settings document, credentials, optional home `.env`, and anonymous identity, while sessions owns `sessions`, `attachments`, and `storages` together. Add the smallest temporary DSH source patch: a public `WorkspaceRegistry.withStorageRestore(restore)` operation that serializes Session-bearing restores with existing Workspace mutations, closes the storage domain, runs the supplied restore, and reopens the domain through the normal initialization path. Configuration-only restore bypasses that unrelated transaction. The distribution references the plugin and the independent patch package; exact selected versions belong only to the deployment lock.

The package name is final from its first commit. The Plus candidate adds only the source and release governance needed to recognize `@sparkelf/*` artifacts; it does not first publish the package under an `@deepseek-ai` name and later rename it. The core installation path is npm/profile based: `dsh plugin --profile plus add @sparkelf/dsh-plus`, followed by the distribution's explicit `dsh-plus apply --dsh-root <official-root>` command and `dsh --profile plus`. The apply command materializes data-only patch metadata and writes the exact lock; it has no install lifecycle script and contains no capability implementation.

## Package and runtime ownership

The Host entry owns explicit source allowlists, 64 KiB compression and restore chunks, the version-2 manifest with scope and Settings filename, validation before mutation, same-name replacement, 2 GiB default upload policy exposed as package configuration, one-use temp-file tokens, cleanup, progress framing, and the four exact routes. Generated profiles, releases, logs, Supervisor files, cached packages, and runtime output never enter any scope. It registers routes through `ctx.webServer.register`; each handler calls `ctx.connection.requestRejection` before reading a body or mutating state. Upload streams the Node request to a Host temp file and never enters Connection's JSON buffer. Export preparation and import write ordered NDJSON progress under response backpressure; GET/HEAD download streams the staged ZIP and consumes only GET.

The Client entry owns the three-way scope control, Settings section, local operation state, upload progress, Host progress parsing, stream-reader release before completion becomes visible, cancellation, scope-specific browser filenames and results, retry, import completion, and reload action. All product copy lives in the package's typed Chinese and English dictionaries. The UI retains the accepted layout and existing semantic tokens; this migration introduces no new shared store, polling, or background recovery.

The Workspace package owns the durable-domain transaction and live cache rebuild. Backup supplies only the file replacement callback. Connection owns Host/Origin/browser authentication. WebServer owns route dispatch. Settings File remains the source of the DSH home path through `settings.documentPath`; deployments without a file-backed settings provider fail package activation rather than choosing another path.

## Data and error flow

Export flows from the selected scope to POST `/api/backup.export.prepare?scope=...`, Host allowlist planning and ZIP output, ordered progress lines, a one-use GET URL, and the scope-specific browser download. Import flows from the file picker to POST `/api/backup.upload`, a one-use token, POST `/api/backup.import`, version/scope/path validation, the scope-selected restore transaction, progress lines, and the visible reload action. The four route parsers are the only untrusted HTTP ingress owners; archive validation is the only manifest and ZIP entry owner. Downstream code consumes validated tokens, progress records, scope, and archive entries without duplicate normalization or fallback fields.

Expected user errors return explicit HTTP status or one terminal progress error and keep the Settings actions available for retry. Unexpected Host exceptions retain their original stack in a stable `[plus-backup]` console error with route and phase but no archive content, settings values, credentials, or filesystem paths. No automatic retry, fallback transport, compatibility protocol, queue, worker, polling loop, or extra lock is added.

## Migration and deletion

The official-base package is implemented first. After its full capability path works, the distribution replaces `@sparkelf/dsh-client-ui-settings-backup` with `@sparkelf/dsh-plugin-backup`, moves the Workspace delta into an independent data-only patch package, and deletes the old ApiProxy Backup API/archive/routes, Connection Backup routes, Client-only package, bundle row, tests, docs, and dependencies in one migration. No dual package name, dual route owner, legacy manifest field, or runtime fallback remains.

No active Agent Note in the official tag covers user-data Backup, so this proposal supersedes none. The existing storage and WebServer notes remain authoritative for their owned mechanisms.

## Delivery stage and verification

This is one capability stage: namespace governance, the Workspace operation, full-stack package, profile composition, independent patch payload, exact lock integration, old-path deletion, docs, locales, and the existing Electron system case all complete before code review and verification. Work is serial because the Workspace method and package Host entry share one runtime contract; parallel file work would not shorten the critical path.

Functional acceptance starts from an official DSH installation and uses the DSH profile command to install `@sparkelf/dsh-plus` and its npm closure. The resulting Plus Web profile is then exercised through one Playwright UI workflow: configuration restore reverts a Settings change while preserving a later Workspace, sessions restore reverts that Workspace while preserving a later Settings change, and all restore reverts both. Each arm exports, downloads, uploads, validates, restores, reloads, and shows its scope-specific result; the same case chooses an invalid ZIP, sees an actionable error, and retries. Browser diagnostics collect console warnings/errors, page errors, failed requests, unexpected HTTP failures, CORS failures, and stalled requests. Desktop and tray applications may invoke this public profile workflow, but they are not prerequisites or acceptance owners. The official tag has no Playwright runner, so the Plus distribution owns the Web Playwright harness; no direct HTTP substitute is added.

## Alternatives considered

**Develop on the accepted fork and adapt both Connection APIs.** Rejected because the adapter would exist only to preserve the source base being removed, increase route ownership, and violate the no-compatibility requirement.

**Put Backup routes into official Connection or ApiProxy.** Rejected because WebServer route registration and Connection trust policy already let the feature own its transport. Only Workspace storage restoration lacks a public operation.

**Restart the Host after replacing files.** Rejected because it weakens the accepted immediate cache restoration behavior, couples Backup to Supervisor, and leaves an ambiguous result if process restart fails after mutation.

**Split Host, Client, archive, and protocol into separate npm packages.** Rejected because they change together for one user capability and would add package and composition overhead without an independent consumer.

**Use JSON RPC and base64 archives.** Rejected because it buffers large archives, loses native upload/download streaming, and cannot preserve accepted progress and memory behavior.

## Acceptance criteria

- `@sparkelf/dsh-plugin-backup` is one public npm package with Host, Client, profile, locale, and dependency closure.
- Official DSH is the only source base; the plugin imports no old ApiProxy or old Connection API and contains no compatibility branch.
- The temporary DSH patch contains only the public Workspace restore transaction and is independently owned, versioned, locked, and retireable.
- All, configuration, and sessions scopes share one archive/validation/restore chain and prove their independent visible state results through Plus Playwright.
- Invalid archives fail before mutation, present a recoverable UI error, and retain original Host stack diagnostics without sensitive content.
- All old Backup owners are deleted when distribution composition switches; no runtime has two route or locale owners.

## Risks

The Workspace restore operation temporarily expands official DSH's public surface and must be retired when an official release provides equivalent storage restoration. A failed restore can leave user files partially replaced; the accepted algorithm intentionally preserves its current same-name replacement semantics rather than introducing an unrequested transaction format or rollback copy. Direct WebServer handlers must apply Connection rejection before body reads on every route; omitting it would expose privileged local data. The 2 GiB default permits large disk and CPU use, so the package keeps the accepted explicit limit as configurable policy and streams all large data.
