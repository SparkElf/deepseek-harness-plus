# @sparkelf/dsh-patch-legacy-code-preset

English | [中文](README.zh.md)

This data-only package preserves sessions created before the official `code` agent preset was renamed to `ptc`. Resume first resolves a real `code` preset, then falls back to `ptc` only when `code` is absent; the browser labels that persisted legacy id as the localized PTC preset. Session logs remain unchanged.

The target is exact official source revision `d347e703908d0406b7a7ef80e3a0e594d86b2215`. The payload is applied before that source tree is built. The package has no JavaScript entry, lifecycle script, Cordis plugin, accepted-fork fallback, or alternate variant.

Retire this package when official DSH provides equivalent legacy preset resolution and display behavior.
