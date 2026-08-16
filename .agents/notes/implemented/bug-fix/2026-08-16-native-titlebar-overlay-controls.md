# Agent Note: Native Desktop Titlebar Controls

Status: implemented

English | [中文](2026-08-16-native-titlebar-overlay-controls.zh.md)

## Problem

The Plus Desktop installer used a frameless BrowserWindow with renderer-owned minimize, maximize, and close buttons. On Windows, Electron drag-region hit testing could consume titlebar pointer input before renderer handlers ran, so the visible controls did not respond. GitHub's hosted Windows session also does not provide reliable automation evidence for Electron window geometry or maximize events.

## Decision

On Windows, apps/plus-desktop/src/main.mjs creates the installer with titleBarStyle: 'hidden' and a 44px titleBarOverlay. Electron and Windows own the minimize, maximize, and close controls. The renderer reserves the overlay width in its brand bar and owns only the branded drag region. installer:apply-appearance updates the overlay background and symbol colors with the selected theme.

Linux and macOS use the default native frame. The preload, renderer, and main-process IPC no longer expose or implement renderer-owned window controls.

## Verification

The desktop Playwright flow starts the actual Electron application on the Windows runner and completes directory browsing through preload and main-process IPC, custom provider validation, and recovery to the review screen. The native Windows workflow ran this flow before building and uploading the NSIS installer in [run 31965864018](https://github.com/SparkElf/deepseek-harness-plus/actions/runs/31965864018). The installer artifact SHA-256 is 6ff7e4e280f7730581b3cbcceaea33bf696344ddea9faed452b7d8b9804457c0.

Interactive Windows acceptance remains the owner for minimize and maximize appearance because hosted Electron automation does not reliably report native window geometry or state events.

## Alternatives considered

**Renderer DOM controls over a frameless window.** The direct click and pointerdown handlers, isolated drag region, and main-process IPC did not receive a usable titlebar event in the Windows Electron automation session. This approach duplicated OS controls and left a platform-specific hit-testing defect.

**Keep a standard Windows frame.** Native controls would work, but the Windows title bar would separate the compact branded installer header from the system buttons. titleBarOverlay retains native control ownership while keeping the intended titlebar composition.

**Gate CI on maximize geometry or isMaximized().** Electron's Windows automation has an open limitation for maximize and window sizing, documented in [Electron issue 33942](https://github.com/electron/electron/issues/33942). CI verifies the installer user flow and package, while an interactive desktop verifies OS window-manager behavior.

## Consequences

Windows controls inherit platform behavior, accessibility, and hit testing from Electron instead of the renderer. Theme changes update native overlay colors. The renderer no longer supplies custom control icons or an IPC interface for window management, and its right titlebar padding must remain wide enough for the Windows overlay controls.
