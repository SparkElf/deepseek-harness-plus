# Agent Note: Installer Proxy And Download Recovery

Status: implemented

English | [中文](2026-08-17-installer-proxy-and-download-recovery.zh.md)

## Problem

The installer relied on the host network path for Git clone and package installation. A TLS connection could close during clone, leaving a partial target directory and no user action to retry with a different proxy.

## Decision

The installation location advanced options include an optional HTTP, HTTPS, SOCKS5, or SOCKS5H proxy URL. The main process passes the configured proxy to Git clone, pnpm version checks, dependency installation, build, upgrade, repair, and update checks. WSL receives proxy variables through an explicit env command inside the selected distribution. The proxy endpoint is retained in the local runtime record for maintenance operations and is excluded from Harness settings and credentials files.

Git clone and dependency installation each retry three times. A final fresh-install network failure removes only the real, installer-owned empty target directory and returns a structured retryable result. [Protected overwrite installation](2026-08-17-protected-harness-overwrite-installation.md) retains the existing checkout and user data when the same network path fails. The renderer presents a Retry action only for that result; non-network failures keep their error without offering an action that cannot recover them.

## Verification

The native Electron workflow validates the proxy field, sanitized review summary, real Git failure through an unreachable local proxy, automatic retry, target cleanup, and manual retry. The Windows NSIS job runs that workflow before packaging.

## Alternatives considered

**Require users to configure Git and pnpm proxy settings manually.** Rejected because the first install has no reliable installed Harness configuration and users should not need to know two tool-specific configuration systems.

**Retry every installer failure.** Rejected because build, configuration, and startup failures are not repaired by repeating a network operation and would produce misleading controls.

**Keep a failed clone in place for resume.** Rejected because Git partial state and a new proxy can produce ambiguous results; clearing the installer-owned target gives each retry the same empty-directory precondition.

## Consequences

A proxy URL with credentials may be retained in the local runtime record so maintenance commands can reuse it; the renderer summary removes credentials before display. Three retries add bounded wait time to network failures, while the final result remains actionable without manually deleting a partial directory.
