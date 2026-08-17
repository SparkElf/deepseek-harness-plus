# Agent Note: Protected Harness Overwrite Installation

Status: implemented

English | [中文](2026-08-17-protected-harness-overwrite-installation.zh.md)

## Problem

The installer accepted only empty directories. A failed clone or an existing Harness checkout therefore required manual directory cleanup before a later install or upgrade, and an unguarded cleanup could destroy user settings and credentials stored under .dsh-plus/home.

## Decision

The location advanced options expose an explicit overwrite choice that states user-data retention. The main process classifies the selected path as empty, an existing Harness checkout, a linked/unsafe path, or another non-empty directory. Empty paths use clone. Existing Harness paths require the overwrite choice and refresh only tracked source files with Git; foreign non-empty paths remain rejected.

The installer does not run git clean during overwrite. [Installer proxy and download recovery](2026-08-17-installer-proxy-and-download-recovery.md) owns bounded network retries; overwrite retries retain the existing target while fresh-install retries may reset their installer-owned directory. It writes settings.yaml and .credentials.yaml only when those files are missing, so existing user configuration and credentials remain unchanged. The selected proxy and other runtime metadata are saved separately in the local runtime record. The review summary states when overwrite mode is active.

## Verification

The native Electron workflow drives the advanced overwrite control, confirms its review summary, and continues through the real installer path. Windows NSIS packaging runs after the Electron interaction test. The runtime directory classifier rejects linked and foreign non-empty folders before source mutation.

## Alternatives considered

**Delete the selected directory and clone again.** Rejected because user data and local runtime files live below the installation directory and cannot be reconstructed from the source repository.

**Treat every non-empty directory as an overwrite target.** Rejected because a folder picker can point at an unrelated project or personal directory; the source markers and explicit checkbox are required.

**Always update the existing checkout.** Rejected because an empty directory must remain the predictable first-install path and an existing checkout may contain intentional local source changes; overwrite is an explicit destructive-source action while user data is retained.

## Consequences

Tracked source edits in an existing Harness checkout are replaced by the fetched main branch when overwrite is selected. Untracked files, including .dsh-plus/home, remain in place. A linked path and an unrelated non-empty folder require a different selection rather than destructive cleanup.
