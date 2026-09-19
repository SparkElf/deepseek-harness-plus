# Agent Note: 镜像重建必须把每项本地改动都变成补丁

Status: proposed

[English](2026-09-16-mirror-local-changes-need-patches.md) | 中文

## Problem

把 3080 deployment 从 DSH 0.1.5-rc.2 提升到 0.1.6-alpha.1 后，"在文件管理器中打开"损坏，其图标变成空白。四个文件承载 deployment 依赖的 WSL 行为，而这次提升把四个全部丢弃：

```
packages/host/open-in-app/src/icons.ts          WSL icon extraction
packages/host/open-in-app/src/resolver.ts       WSL application resolution
packages/util/native-command/src/index.ts       WSL command dispatch
packages/util/native-command/src/path-opener.ts WSL path translation
```

提升用 `dsh-plus apply` 重建 runtime mirror，它会重置 checkout 并重新应用已声明的 patch set。那四个文件是**未提交的 working-tree 改动**，没有任何 patch package 覆盖，因此重置把它们删除。用户可见结果是红色"打开失败"提示与空白图标。

## Why it reached production

三个相互独立的缺口，每个单独即可导致事故：

**镜像承载了没有 patch 描述的本地工作。** 一个标题为 "mirror local customizations" 的 stash 有九个文件。我把其中一个（`session-format-v0-to-v1/relationships.ts`）转成 patch，把另外八个与仓库比对，发现存在，就判断它们安全。**那个检查回答的是错误的问题。** 它们存在于*仓库*中，但镜像从*patch package*重建；一个存在于仓库、却没有对应 patch 的文件仍然会消失。正确的检查是每项本地改动是否有能复现它的 patch，而不是仓库里是否存在相似内容。

**closure gate 看不见"删除"。** `verify-plus-profile-upgrade` 比较 package 的 **fingerprint**。重置之后，`@deepseek-ai/dsh-open-in-app` 仍以相同版本存在，只是 fingerprint 不同——而另外 284 个 package 本就因正当理由有 fingerprint 变化，因此真正重要的那一个无法区分。没有任何声明要求"该 fingerprint 必须包含 WSL marker"。

**陈旧的增量编译缓存掩盖了缺失的恢复。** 把 WSL patch 应用回去之后，我用 `npx tsdown --env.DSH_BUILD_FACE host` 重建。该 package 的 `tsconfig.tsbuildinfo` 来自 14:19，而恢复后的源码来自 16:49，于是 TypeScript 认为输出是最新的，打包出的 `lib/index.js` 保留了 patch 前的代码。源码里有 `wslpath`，artifact 里没有。我验证了源码，没有验证 artifact。

## Proposal

1. **提升之前，枚举被服务镜像中的每一项未提交改动，并要求每项都有 patch。** 没有 patch 的改动就是提升会删除的改动。把该枚举作为提升的输入，而不是事后复查。
7. **在 artifact 层验证，而不是 source 层。** 在构建出的 `lib/index.js` 中 grep 该改动写入的 marker，并实际调用它服务的 endpoint 或命令。对源码的 grep 不构成关于运行中 deployment 的证据。
2. **恢复后的重建要先删除 `tsconfig.tsbuildinfo`，或使用 deployment 自己的构建命令。** 时间早于该改动的增量缓存会静默复用上一次输出；构建成功且不报告任何异常。
3. **给每个 patch 一个 capability probe。** 恢复行为的 patch 应声明一个 marker 字符串，closure gate 应要求候选 fingerprint 中含有该 marker。未声明的 fingerprint 变化于是成为违规，而不是几百行中的一行。
4. **先在 staging port 上提升。** 3081 实例正是为此存在。直接在 3080 上验证 WSL 行为意味着一次失败的提升就是用户的第一个信号。

## Acceptance criteria

- 提升脚本枚举未提交的镜像改动，并在任何一项没有 patch 时失败。
- 每个行为性 patch 声明 probe；closure gate 在构建产物中验证该 marker。
- 恢复后的重建在清除增量状态后运行 deployment 自己的构建命令。
- 依赖 WSL 的行为在 3080 被移动之前先在 staging port 上验证。

## Alternatives considered

- **以仓库作为镜像改动的记录。** 拒绝：文件确实存在于仓库中，而提升仍然丢失了它们。只有在重建后的镜像中，patch 才能复现一项改动。
- **复制镜像而不是重建。** 早前因体积被拒绝；而且它也帮不上忙：镜像的 revision 必须移到新基线，因此每个文件都会变化。

## Risks

- 为每个 patch 要求 probe 会增加维护成本；若 marker 命名的是内部符号而非稳定字符串，minification 会破坏它。Probe 应命名代码写入的路径、常量或字面量。
- 清除增量状态会延长每次重建的时间。在被服务 artifact 的正确性与提升路径上的构建时间之间，前者优先。
