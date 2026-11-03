# Agent Note: DataOps 变体声明完整插件集

Status: implemented

[English](2026-10-30-dataops-variant-plugin-set.md) | 中文

## Problem

DataOps 工作区镜像比它替换掉的 profile 少了若干插件。基线升级改变了运行时线，镜像改从 Plus profile 组装，于是部署赖以存在的多项能力——知识库、凭据管理、群聊、引用、任务总线，以及连接器自己的查询结果分析——直接缺失，而构建与启动都报告成功。

两份声明互相不一致，而且都不完整。变体 `dshPlus.profile.standaloneVariants.dataops` 只声明了两个新增包。大多数 DataOps 插件从未进入任何持久声明：它们只是构建机通过 `--extra-plugins` 递进来的 tarball，因此没有该目录的构建会静默丢掉它们。镜像验收的 `REQUIRED` 同样只列了两个包，既不符合旧 profile，也不符合部署的真实需要。

## Decision

变体是「所有可从 registry 安装的部署插件」的持久声明。`includePackages` 增加知识库、凭据管理、群聊、引用与任务总线及其评审版本（连接器与查询结果分析原本已在），`includeBundles` 挂载同一组；`@sparkelf/dsh-dataops-managed` 升到 0.3.21。生成的 `packages/standalone/dataops-standalone/package.json` 由变体重新生成，顺带补上了清单此前已漂移的一个依赖。

有两个包无法加入 registry 集合：`@sparkelf/dsh-dataops-account` 与 `@sparkelf/dsh-ocr` 是私有构建，不发布任何版本。它们留在 `--extra-plugins` 路径，并由一份随仓库提交的声明记下精确版本。该声明是构建两半共同读取的唯一来源：profile 组装器在必装插件未安装、无 bundle 行或版本不符时失败；镜像验收从镜像里读取同一文件，检查安装树与 bundle 行。丢插件的构建从此会停下，而不是交付。

`dsh-video-preview` 退出变体。它的 0.1.4 需要 0.2.2 基线不再提供的运行时服务，因此变体记录该省略，而不是挂载一个无法激活的包；镜像验收像对待已退役的管理包一样断言它缺席。`@sparkelf/dsh-dataops-admin` 保持退役，两个列表都不含它。

旧 profile 的 `@sparkelf/dsh-better-sidebar@0.28.0-sparkelf.grid.17` 不再携带。它的 peer 范围钉住 0.2.1 线与 `@huanlin/dsh-plugin-better-locale`，而镜像已不再安装后者，挂载它只会让侧栏被 defer，而不是恢复。变体保留经评审的非 scoped `dsh-better-sidebar@0.28.0`。

## Alternatives considered

**把私有插件放进 `includePackages`。** 否决，因为两个包都没有发布，其中一个还是 `private: true`；registry spec 会让安装失败，而不是什么都不装。

**只在镜像验收里保留完整清单。** 否决，因为验收发生在镜像已存在之后：它能报告丢失，却阻止不了从一开始就没带 tarball 的构建，而且会把变体复制到第三处。

**在 standalone 清单里把额外插件写成 `file:` spec。** 否决，因为该清单是发布到 registry 的产物：构建机路径对其他安装者不存在。

**照旧 profile 精确挂载 scoped 侧栏分支。** 否决，因为它的 peer 钉住上一运行时线和一个镜像已移除的 locale 插件；能力会保持休眠，而包与 bundle 行却通过所有结构检查。

## Testing

`pnpm run verify:standalone-variants` 从发行层重新生成清单并比较；它在本次改动前因 stale 失败，改动后通过。`pnpm run verify:standalone-manifest` 保证未裁剪的 Plus 清单不变。生成器的 peer override 测试覆盖新 pin 使用的版本解析。

必装声明在 DataOps 仓库直接测试：`node --test infra/docker-workspace/dataops-required-plugins.test.mjs` 覆盖完整 profile、变体停止声明的 registry 插件、安装但无 bundle 行的包、缺失的私有 tarball、版本不符的私有 tarball，以及声明文件自身的校验。

## Related decisions

发行层拥有评审集合、变体对它做裁剪；这一所有权与 patch 范围的理由仍由 [ranged Plus patchset distribution](2026-08-29-ranged-plus-patchset-distribution.zh.md) 拥有。DataOps 连接器自身的插件行为——有效能力、工具注册、后端为最终边界——仍记录在 `dataops/docs/dataops-connector-development-spec.md`。

## Consequences

DataOps standalone 发布现在比 Plus 集合多带七个 registry 插件，因此 standalone 清单与部署 profile 都随变体增长，而不是随构建目录增长。下一条运行时线必须在该版本上重新生成清单，并选择发布兼容的 `dsh-video-preview` 或保留其省略；在做出选择之前，验收会持续让镜像失败。

两个私有插件仍是源码检出本身无法满足的唯一要求：镜像构建需要由 `dsh-plugins-plus` 构建的 tarball，缺少或版本不符时组装器会中止构建。