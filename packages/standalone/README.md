---
description: "Package map for the standalone Plus installation: one registry package that a user installs and runs without a source checkout or a build."
kind: "package-group"
---

# standalone/ — SparkElf Plus standalone installation

English | [中文](README.zh.md)

## Summary

The `standalone/` group holds the package a user installs to run Plus from the registry. `@sparkelf/dsh-plus-standalone` is a manifest rather than a library: its dependencies select the official runtime and every reviewed plugin, and its generated `dshPlusStandalone.bundles` list is the order the launcher mounts them in. The `dsh-plus` command that owns the lifecycle ships in [`bundle/plus/`](../bundle/plus/README.md), because a source-based installation and a registry installation drive the same executable.

## Packages

| Package | Role | ctx key |
|---|---|---|
| [`plus-standalone/`](plus-standalone/README.md) | Registry entry point: pins the runtime and the plugin set, and carries the generated mount order | none; it is installed, not mounted |
