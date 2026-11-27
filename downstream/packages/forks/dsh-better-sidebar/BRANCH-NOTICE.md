# extraMenuItems 分支去向（决定记录）

日期：2026-10-21

## 现状
`extraMenuItems` 只存在于本仓库 fork 的 `sparkelf/kb-save-events` 分支
（commit `9299f58`，已 push 到 `fork` = SparkElf/DSH-better-sidebar），
`master` 上没有；`origin` 指向 `omdsh-dev/DSH-better-sidebar` 且本账号无推送权限（403）。

已发布到 npm：`@sparkelf/dsh-better-sidebar@0.26.0-sparkelf.5`。

## 决定
1. **长期维护以 fork 的 `sparkelf/*` 分支为准**，不尝试合入 `omdsh-dev` 上游。
   理由：无推送权限；且该 prop 是我们为知识库单独加的，上游未必接受。
2. 版本号继续用 `0.26.0-sparkelf.N` 的预发布序列，发布必须带 `--tag sparkelf`
   （npm 拒绝不带 tag 的 prerelease）。
3. `lib/` 是构建产物、不入库；任何消费方必须从 npm 拿包，不要在仓库间直接引用源码。
4. 知识库插件的构建当前**内联打包**了 `FileTree` 源码，因此升级本包后
   必须同步更新 `dsh-plugins-plus/node_modules/.pnpm/.../FileTree.tsx` 再重建，
   否则改的 bundle 不会生效（这一坑已踩过一次）。

## 待办
- 若将来要长期共存，应把 `extraMenuItems` 提到稳定分支并打正式版（去掉 `-sparkelf.N`）。
