# Agent Note: Staged Installer Progress

Status: implemented

English | [中文](2026-08-17-staged-installer-progress.zh.md)

## Problem

The installer displayed only a spinner and a phase sentence while downloading, installing dependencies, and building Harness. The operator could not tell whether work was advancing or how the current phase related to the remaining installation.

## Decision

The main process publishes one staged progress contract with a percentage and phase message. Preparation, environment checks, Git download, settings, dependency installation, build, startup, and completion occupy explicit ranges. Git's real Receiving objects and Resolving deltas output maps into the download range; pnpm output remains activity for its phase rather than being misrepresented as total completion.

The renderer shows a compact accessible progressbar, percentage, spinner, and localized phase text beneath the install summary. Failed commands hide the progress surface and retain the error message. Preview cannot enter this flow and therefore cannot emit simulated installation progress.

## Verification

A browser UI harness drove the same progress payloads through the actual renderer and observed the percentage, aria-valuenow, phase text, and filled track. The native Windows Electron workflow runs the installer interaction before the NSIS package build; the progress contract is part of the packaged renderer source.

## Alternatives considered

**Show only an indeterminate spinner.** Rejected because the operator cannot distinguish active work from a stalled download or understand remaining phases.

**Treat pnpm resolved/downloaded counts as a global percentage.** Rejected because those counts are scoped to one package-manager operation and do not represent the full installer lifecycle.

**Add byte-level progress for every command.** Rejected because Git and pnpm do not expose one stable total byte contract across native and WSL targets; stage progress is honest and comparable across targets.

## Consequences

The progress percentage communicates lifecycle position rather than exact remaining time. Git download can advance within its range when its native progress output is available; dependency installation and build advance at phase boundaries. The main process and renderer must keep the phase ranges and localized messages aligned.
