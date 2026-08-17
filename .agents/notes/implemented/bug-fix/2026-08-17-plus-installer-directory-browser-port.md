# Agent Note: Plus Installer Directory Browser Port

Status: implemented

English | [中文](2026-08-17-plus-installer-directory-browser-port.zh.md)

## Problem

The Plus Desktop installer had a smaller single-column directory dialog that returned a fabricated Windows path in renderer preview. It did not preserve the Harness directory browser's breadcrumb, Miller-column, nested-create, or hidden-entry interaction, and preview could look like a completed installation.

## Decision

The installer keeps its plain HTML and JavaScript renderer but ports the complete interaction contract of the [Harness directory browser](../../architecture/2026-07-28-directory-picker-capability-seam.md): a 680 by 500 dialog, breadcrumb path bar with an edit affordance, selection-anchored Miller columns, nested new-folder dialog, hidden-entry toggle with a check, and Open fallback to the listed level when no folder is selected.

The Electron main process supplies the real platform home directory, filesystem ancestry crumbs, and a name-sorted listing capped at 1,000 entries through the existing preload IPC. The renderer never invents a Windows username or directory listing. Node directory entries identify dot-prefixed hidden names; Windows hidden and system attributes remain unavailable through this API, matching the existing Harness browse limitation. A browser preview has no filesystem capability and rejects folder selection and installation instead of emitting a simulated path or progress event.

## Verification

The complete Miller layout was driven through a browser visual harness with the same home, crumbs, and entries fields as Electron IPC. It showed the selected left column, child right column, breadcrumb, footer actions, and 680 by 500 dimensions. The real Electron Playwright flow asserts that the initial path is not the old C:\Users\you sentinel, that selection creates the second column, and that Open returns the selected directory on the Windows runner.

## Alternatives considered

**Use the native Windows folder dialog.** Rejected because the installer must reuse the Harness in-app directory browser and retain the same interaction on every supported target.

**Keep a smaller bespoke single-column dialog.** Rejected because it changes established navigation semantics, hides the selected directory's children, and was the source of the visual mismatch reported for the installer.

**Let preview simulate installation.** Rejected because a browser cannot access the target machine's installation filesystem or runtime process. A successful-looking preview makes an uninstalled application indistinguishable from a completed installation.

## Consequences

Windows and WSL installation flows use one directory browser interaction while their main-process path adapters remain separate. The directory browser's visual and keyboard behavior must stay aligned with the Harness component contract when that component changes. Preview remains useful for static layout inspection but cannot claim filesystem or installation success.
