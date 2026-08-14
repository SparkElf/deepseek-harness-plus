# Agent Note: Desktop Tray Manager

Status: proposed

English | [中文](2026-08-14-desktop-installer-tray-daemon.zh.md)

## Problem

A person uses DeepSeek Harness through its browser page, but the first local runtime needs an installation path, native provider credentials, a default model, and a service port before that page can open. Once installed, a second desktop settings surface would duplicate the Web page and create conflicting owners for models, credentials, presets, and workspace selection.

## Proposal

Plus will provide a tray-resident Electron manager for macOS, Linux, and Windows. When no local runtime exists, it opens a one-time setup guide for an empty installation directory, local port, DeepSeek key, default model, and optional reasoning effort. The guide clones and builds Plus, writes the initial native settings and key under an isolated DSH_HOME, starts dsh web, opens the browser page, and closes.

After installation, the manager owns only local runtime lifecycle actions: start, stop, open the browser page, upgrade with a fast-forward pull and rebuild, and repair locked dependencies and build output. It does not expose models, credentials, presets, or workspace settings again. Harness Web owns every later user-facing configuration and agent interaction.

This partially revises [Source run without a managed installer](../../implemented/simplification/2026-08-10-source-run-without-managed-installer.md) for the Plus distribution only. Upstream Harness remains source-run without a managed installer; that note remains current for its released surface.

## Alternatives considered

**Give Electron a permanent settings renderer.** This duplicates the Web settings page and gives the desktop process a conflicting role over models, credentials, presets, and workspaces.

**Collect no initial configuration.** The Web service cannot use a selected default model or native credential until one exists; a first-run guide gives those bootstrap values one clear owner.

**Leave lifecycle controls in shell scripts.** A browser user would still need to locate the checkout and remember service commands for ordinary install, repair, and upgrade actions.

## Acceptance criteria

- An initial guide captures installation path, port, DeepSeek key, default model, and reasoning effort before the first service starts.
- After installation, the tray menu can start, stop, open the local Web URL, upgrade, and repair one isolated Plus checkout without reopening those settings.
- The Web page is the only later user-facing model, credential, preset, workspace, and agent surface.
- macOS DMG, Linux AppImage/deb, and Windows NSIS packages build on their matching runners and contain the same guide and tray actions.
- A desktop-capable end-to-end environment verifies installation, service readiness, browser open, stop, upgrade, and repair before publication.

## Risks

The initial source requires Git and pnpm already installed. The guide writes an initial DeepSeek key as part of installation, so its preload bridge remains limited to installation IPC and closes after success. Cross-platform installers and native desktop workflow verification remain unshipped until matching runners produce and validate artifacts. Upgrade uses only fast-forward Git updates; recovery from a modified checkout needs a separate, explicit user decision.
