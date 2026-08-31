---
description: "Streamed, authenticated export and validated restore of file-backed DSH user data with browser progress."
kind: "package-reference"
---

# @sparkelf/dsh-plugin-backup

English | [中文](README.zh.md)

## Summary

This complete Host and Client plugin exports and restores three explicit user-data subsets: everything, configuration only, or sessions only. Configuration contains the active Settings document, credentials, optional `.env`, and anonymous identity; sessions contain Session logs, attachments, and storage-backed Workspace/projection state. Export, upload, and import stream through Host temporary files with bounded NDJSON progress; import validates the versioned manifest, scope, paths, and expanded byte total before mutation.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the Host entry after `connection`, `webServer`, `settings`, and `workspaceRegistry`, and mount the Client entry after locale and Settings. The file-backed Settings provider supplies `settings.documentPath`; `maxUploadBytes` defaults to 2147483648 bytes.

The Settings section uses a three-way segmented control. **Everything** is the union of configuration and sessions; it does not archive generated profiles, releases, logs, Supervisor files, cached packages, or other runtime output. **Configuration** restores only configuration files and leaves Session/Workspace storage open. **Sessions** restores `sessions`, `attachments`, and `storages` together inside the Workspace storage-restore transaction. The archive manifest records the scope and active Settings filename; configuration-bearing archives require the same Settings filename at import.

The authenticated routes are POST `/api/backup.export.prepare?scope=all|configuration|sessions`, GET/HEAD `/api/backup.export`, POST `/api/backup.upload`, and POST `/api/backup.import`. Every route applies Connection Host, Origin, and browser-authentication policy before request data. Browser cancellation settles only the active route and never terminates the Harness Host. Tokens expire after ten minutes and are single-use, except HEAD metadata inspection.

Once restore writes begin, closing the page does not interrupt replacement. Workspace storage closes around file replacement and reopens before completion; the Client releases the completed progress stream reader before the UI offers one explicit reload. Client failures remain visible in the Backup section without browser console errors.

-----

<a id="model-experience"></a>
## Model Experience

### Backup operations

#### What the model sees

Nothing. `@sparkelf/dsh-plugin-backup` keeps Backup archives, progress, failures, and restored files in Host storage and the Settings UI; this package registers no model-facing tool, prompt section, or Session event.

#### Token effect

Zero. Backup operations add no model-request tokens.

#### KV Cache effect

Independent. Export, import, progress, and reload do not change a model request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Overwrite without rollback**: restore replaces same-name files within the declared scope, retains files absent from the archive, and creates no rollback copy if a disk write fails after mutation begins.
- **Current archive format only**: scoped archives use manifest version 2; pre-release version 1 archives are rejected instead of being guessed into a scope.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers, click to expand</summary>

This Dev Note is working context for maintainers; shipped behavior, limits, and rationale live in the sections above, the package code, and the linked Agent Note.

- The [Backup Agent Note](../../../.agents/notes/proposed/architecture/2026-08-30-plus-backup-plugin.md) owns archive, route, restore, and progress decisions; `src/index.ts` and `src/client/BackupSection.tsx` own current behavior.

</details>
