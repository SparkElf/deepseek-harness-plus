---
description: "Optional Electron tray client for a configured Plus Supervisor."
kind: "package-reference"
---

# @sparkelf/dsh-plus-desktop

English | [中文](README.zh.md)

## Summary

This optional Electron tray package reads an existing Plus Supervisor manifest, starts the standalone Supervisor when it is absent, and presents tray commands for opening Harness and its progress page or starting, stopping, restarting, and rebuilding the runtime. It contains no DSH source installer and does not own the Web child process.

## Use This Package

An Electron host imports <code>runPlusDesktop</code> and passes its Electron module plus an optional <code>manifestPath</code>. The default path is <code>~/.dsh/supervisor/runtime.json</code>. Closing the host leaves the Supervisor and Harness runtime running.

## Model Experience

Desktop adds no model content. A restart selected from its tray delegates to the Supervisor package, whose recovery prompt and token effect are documented in [the Supervisor README](../../packages/plus/supervisor/README.md#model-experience).

## Known Limitations and Deferred Work

- Desktop manages an already materialized Plus runtime; installation remains owned by <code>@sparkelf/dsh-plus</code>.
