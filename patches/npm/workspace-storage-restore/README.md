# @sparkelf/dsh-patch-workspace-storage-restore

English | [中文](README.zh.md)

Data-only temporary patch for the official DSH source revision `0a53fb55bea101816fa226bb964ae2bed71c343b`. It adds `WorkspaceRegistry.withStorageRestore`, which closes the Workspace durable domain around an external file replacement and reopens through normal initialization before returning.

The target source revision identifies `dsh-v0.1.2-alpha.1`. That tag has no matching published `@deepseek-ai/dsh-workspace` npm artifact, so this variant cannot truthfully target an npm package version. The Plus distribution declares this exact official base revision; the materializer verifies that base is an ancestor of the Plus checkout, verifies the repository-root payload with `git apply --check`, and then builds DSH from that official source base plus the selected Plus artifacts. There is no alternate revision, fuzzy application, or runtime code in this package.

Retire this package when an official DSH release exposes an equivalent Workspace storage restore operation and `@sparkelf/dsh-plugin-backup` can consume it without a local payload.
