# Agent Note: Desktop Installer and Tray Daemon

Status: proposed

English | [中文](2026-08-14-desktop-installer-tray-daemon.zh.md)

## Problem

Running a local Harness workspace requires cloning the repository, selecting a separate home, configuring a native provider, building source, and remembering a terminal command to manage the Web service. These setup steps are separate from the agent task a new operator wants to start.

## Proposal

Plus will add a private Electron workspace application with a three-step setup renderer, a context-isolated preload API, and a main-process HarnessDaemon. The setup will accept an empty installation directory, existing workspace directory, local port, DeepSeek key, model, reasoning effort, and start behavior. The main process will clone the Plus repository, run its locked install and build, write an isolated DSH_HOME with native DeepSeek settings, and store the key in a local owner-only environment file.

The daemon will start dsh web with DSH_HOME, Code Mode, and the selected port. Closing the setup window will hide it while the Electron tray owns the process. The tray will offer start, stop, open UI, open logs, and quit actions.

This partially revises [Source run without a managed installer](../../implemented/simplification/2026-08-10-source-run-without-managed-installer.md) for the Plus distribution only. Upstream Harness remains source-run without a managed installer; that note remains current for its released surface.

## Alternatives considered

**Use the existing Web UI as an installation wizard.** The Web entry depends on an already built and running Harness service, so it cannot create the local runtime that it needs in order to open.

**Write settings into the default Harness home.** That would overwrite or mix settings with another local Harness installation.

**Offer unverified custom-provider import in the first wizard.** The current native provider configuration is DeepSeek-specific. Recording a custom endpoint without a validated Harness provider would produce a setup screen that promises an unusable route.

## Acceptance criteria

- The installer clones the Plus fork to an empty selected directory, creates an isolated DSH_HOME, writes native DeepSeek settings, and starts the requested port.
- The tray can start, stop, open, and exit the configured local service after its window closes.
- A produced Linux package contains the renderer, preload, and main-process daemon, and the same release workflow defines the Windows and macOS artifacts.
- The release verifies the installation workflow through a desktop-capable end-to-end environment before presenting any installer as downloadable.

## Risks

The initial code has a Linux unpacked package validation but no released platform artifacts or desktop-capable end-to-end environment. The product must remain marked in development until those paths are complete. The installer owns a source checkout and build lifecycle, so future upgrades and rollback must be designed explicitly rather than implied by the initial clone flow.
