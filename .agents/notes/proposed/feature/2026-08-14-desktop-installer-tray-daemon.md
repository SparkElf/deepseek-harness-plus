# Agent Note: Desktop Tray Manager

Status: proposed

English | [中文](2026-08-14-desktop-installer-tray-daemon.zh.md)

## Problem

A person uses DeepSeek Harness through its browser page, but the first local runtime needs an installation path, native provider credentials, a default model, and a service port before that page can open. Once installed, a second desktop settings surface would duplicate the Web page and create conflicting owners for models, credentials, presets, and workspace selection.

## Proposal

Plus will provide a tray-resident Electron manager for macOS, Linux, and Windows. When no local runtime exists, it opens a one-time, single-column setup guide that uses the Harness design tokens and brand assets. Language and theme selections change the guide immediately and become the installed Harness defaults. The guide also collects an empty installation directory, local port, DeepSeek key, default model, and optional reasoning effort.

Windows users choose either the Windows filesystem or one installed WSL distribution. The selected target owns the checkout, DSH_HOME, settings, Git and pnpm commands, Supervisor, Harness Web process, rebuilds, repairs, and updates. Linux and macOS use their native environment. The guide clones and builds Plus in that target, starts Harness Web, opens the browser page, and closes.

After installation, the manager owns only local runtime lifecycle and navigation actions. Its tray shows Supervisor and Harness status; opens the production Harness and Supervisor pages independently; exposes the candidate Harness entry only when the candidate Supervisor reports its managed runtime; starts, stops, rebuilds, checks for available commits without installing them, upgrades, repairs, and opens the target data directory. It does not expose models, credentials, presets, or workspace settings again. Harness Web owns every later user-facing configuration and agent interaction.

This partially revises [Source run without a managed installer](../../implemented/simplification/2026-08-10-source-run-without-managed-installer.md) for the Plus distribution only. Upstream Harness remains source-run without a managed installer; that note remains current for its released surface.

## Alternatives considered

**Give Electron a permanent settings renderer.** This duplicates the Web settings page and gives the desktop process a conflicting role over models, credentials, presets, and workspaces.

**Collect no initial configuration.** The Web service cannot use a selected default model or native credential until one exists; a first-run guide gives those bootstrap values one clear owner.

**Leave lifecycle controls in shell scripts.** A browser user would still need to locate the checkout and remember service commands for ordinary install, repair, and upgrade actions.

## Acceptance criteria

- The guide presents one vertical task flow, and changing its language or theme immediately changes its copy and appearance before those preferences are saved.
- On Windows, the guide chooses Windows or WSL; WSL also chooses an installed distribution and keeps installation and runtime commands inside it.
- An initial guide captures installation path, port, DeepSeek key, default model, and reasoning effort before the first service starts.
- After installation, the tray displays Supervisor and Harness status, opens production and Supervisor pages, enables candidate navigation from live candidate Supervisor status, and can start, stop, rebuild, check for updates, upgrade, and repair one isolated Plus checkout without reopening those settings.
- The Web page is the only later user-facing model, credential, preset, workspace, and agent surface.
- Linux AppImage/deb and Windows NSIS packages build on their matching runners and contain the same guide and tray actions; macOS packaging resumes only after Developer ID signing and notarization are configured.
- A desktop-capable end-to-end environment verifies installation, service readiness, browser open, stop, upgrade, and repair before publication.

## Risks

The selected target requires Git and pnpm. WSL installation also requires an installed distribution with those tools. The guide writes an initial DeepSeek key as part of installation, so its preload bridge remains limited to installation IPC and closes after success. Cross-platform installers and native desktop workflow verification remain unshipped until matching runners produce and validate artifacts. Upgrade uses only fast-forward Git updates; recovery from a modified checkout needs a separate, explicit user decision.
