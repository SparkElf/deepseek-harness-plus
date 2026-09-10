# @sparkelf/dsh-patch-legacy-code-preset

English | [中文](README.zh.md)

This data-only package preserves sessions created before the official `code` agent preset was renamed to `ptc`. Resume first resolves a real `code` preset, then falls back to `ptc` only when `code` is absent; the browser labels that persisted legacy id as the localized PTC preset. Session logs remain unchanged.

The target is exact official source revision `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`. The payload is applied before that source tree is built. The package has no JavaScript entry, lifecycle script, Cordis plugin, accepted-fork fallback, or alternate variant.

Retire this package when official DSH provides equivalent legacy preset resolution and display behavior.
