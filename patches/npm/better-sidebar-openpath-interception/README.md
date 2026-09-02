# Better Sidebar alpha.2 open-path patch

English | [中文](README.zh.md)

This data-only npm package updates the verified `dsh-better-sidebar 0.17.1` target from the removed `ctx.workspaces.openPath` funnel to the DSH alpha.2 `remote.session.openWorkspacePath` namespace. Chat file links open in the sidebar and return the required Typert success envelope instead of falling through to the host operating system.

The patch composes after the existing Better Sidebar Settings and AppFrame payloads. It preserves the target's default interception setting, requires a selected session cwd, restores the namespace accessor on disposal, and installs the shadow only while interception is enabled. It also restores the missing `host-route-url.ts` source declaration required to rebuild the already-patched package.

## Model Experience

This package registers no Cordis plugin and adds no model-visible text. It only restores the existing Better Sidebar file-open behavior on DSH alpha.2.

## Known Limitations and Deferred Work

The single variant supports exactly `dsh-better-sidebar 0.17.1` on DSH `>=0.1.2-alpha.2`. Remove it when an independently published Better Sidebar version carries the same remote namespace implementation.
