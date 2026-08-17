# Agent Note: Release Version Manager And AI Merge Upgrade

Status: implemented

English | [中文](2026-08-17-release-version-manager-and-ai-merge-upgrade.zh.md)

## Problem

The tray update action reported only a count of upstream commits and direct upgrade followed the remote branch. It did not expose release versions, rollback targets, or a way to integrate a release with local source changes.

## Decision

The tray opens a version manager backed by the repository's plus-v release tags and their peeled commit refs. Each row offers a normal source refresh action and an AI merge action. Normal refresh fetches and resets the selected exact commit, rebuilds dependencies, and restarts the existing runtime when it was running. This same action handles rollback to an older release and records the selected source ref in runtime metadata.

AI merge creates a real Harness Web session with the installed workspace as cwd, submits an explicit instruction to inspect local changes, preserve .dsh-plus/home, fetch and integrate the selected release, resolve conflicts, and run checks, then opens that session in an Electron BrowserWindow by restoring dsh.sessions.current before reload. The user can review the agent's work in the normal Harness interface.

## Verification

The Windows Electron package includes the version manager renderer and the release-pinned source generator. The Windows NSIS workflow remains the packaging gate after native installer interaction. Git exact-SHA fetch is verified against the public fork, and the source reference is generated from the PR head commit for pull-request builds or the checked-out commit for release builds. Native Windows command failures are decoded from UTF-8 or GBK before they reach the renderer, and the root web build invokes the web package through npm so the bundled pnpm does not depend on a shell-global pnpm command.

## Alternatives considered

**Count commits ahead of the remote branch.** Rejected because commit counts do not identify a release or offer a rollback target.

**Use the remote default branch for every tray upgrade.** Rejected because it makes a release non-reproducible and can install code newer than the packaged desktop manager.

**Silently merge local code during normal upgrade.** Rejected because conflict resolution needs model/tool actions and user-visible review; the normal mode remains deterministic source replacement while AI merge is explicit.

## Consequences

The version list depends on reachable repository tags and the configured proxy. Normal upgrades replace tracked source files at the selected commit and preserve untracked user data. AI merge can change the workspace through ordinary Harness tools and therefore starts a separate session with an explicit task instead of mutating the checkout from the tray process.
