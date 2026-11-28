# Agent Note：退役 image hoist 插件

Status: implemented

[English](2026-11-28-retire-dsh-image-hoist.md) | 中文

## 问题

`@sparkelf/dsh-image-hoist` 在当前 LLM route 出现在其 `providers` 列表时写入 `image/hoist` 行。两个出货挂载都设置了 `providers: []`：Plus bundle patch 和 DataOps 嵌入式 overlay。没有任何出货 profile 写过这类行，但这个包仍然带着一个依赖、运行时镜像里的一份 copy、一条第三方 notice，以及 downstream 迁移清单里的一个 excluded 条目。

回放那一半是独立的。`image-offload-hoist-replay.patch` 让 `compaction-image-offload` 和 `session-query` 容忍按 hoisted carrier 记录的位置，对于早先确实启用过该插件的部署写下的会话仍然必需。

## 决定

从发行物中移除该插件：`packages/bundle/plus/cordis.patch.yml` 与 `images/workspace/context/dataops-dsh-embedded.patch.yml` 里的 insert 块、`packages/bundle/plus/package.json` 里的 `@sparkelf/dsh-image-hoist` 依赖、`downstream/image/Dockerfile` 与 `downstream/tools/downstream.mjs` 里的 copy，以及 `THIRD_PARTY_NOTICES.md` 里的那一行。

这取代了[所有权说明](../architecture/2026-10-30-plus-patchset-and-component-ownership.md)中 `image hoist 回放` 那条“继续作为自研插件”的应用记录。

## 备选方案

**把写入端搬进 dsh-source patch。** 否决：写入端读取当前 route，并在 `agent/pre-step` 追加插件拥有的 `image/hoist` 事件。把它搬进官方源码会把 Plus 的事件类型和 route 策略硬编码进并不拥有它们的包，而且会把行为应用到所有部署，而不是配置里点名的 route。

**保留 inert 挂载。** 否决：它会为一个没有任何出货 profile 启用的行为保留依赖、镜像 copy 和 notice。需要 hoist 的部署可以自己把已发布包装进自己的 profile。

## 后果

出货 profile 行为不变：两个挂载都是 inert。已经包含 `image/hoist` 行的会话仍可通过回放 patch 读取；没有 projection 时，这些会话按图片留在持久化的 tool-result 位置读取，也就是未 hoist 的请求形态。包仍以 0.1.5 留在 npm 供显式 opt-in，源码留在已归档的 `dsh-plugins-plus` 仓库。

## 验证

两个 patch 文件都能解析为 YAML 数组且不含 `image-hoist` 条目；`packages/bundle/plus/package.json` 和 lockfile 无引用；`node --check downstream/tools/downstream.mjs` 通过。`verify:plus-governance` 在当前 checkout 无法完成，因为它的 production install 在没有 devDependencies 的情况下运行 better-sidebar 的 `prepare` 脚本（`tsdown: not found`），这是与本次改动无关的既有失败。
