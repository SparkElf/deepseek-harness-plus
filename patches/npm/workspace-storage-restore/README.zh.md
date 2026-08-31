# @sparkelf/dsh-patch-workspace-storage-restore

[English](README.md) | 中文

针对official DSH source revision `0a53fb55bea101816fa226bb964ae2bed71c343b`的data-only temporary patch。它增加`WorkspaceRegistry.withStorageRestore`，在external file replacement期间关闭Workspace durable domain，并在return前通过正常initialization重开。

target source revision对应`dsh-v0.1.2-alpha.1`。该tag没有匹配的已发布`@deepseek-ai/dsh-workspace` npm artifact，因此该variant不能诚实地指向npm package version。Plus distribution声明这个exact official base revision；materializer验证该base是Plus checkout的ancestor，通过`git apply --check`验证repository-root payload，然后从official source base与selected Plus artifacts build DSH。本package没有alternate revision、fuzzy application或runtime code。

当official DSH release提供等价Workspace storage restore operation，且`@sparkelf/dsh-plugin-backup`无需local payload即可消费时，retire本package。
