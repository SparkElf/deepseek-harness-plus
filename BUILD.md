# DSH Plus Monorepo Build

状态：migration 阶段。`status` / `sync` / `verify` / `apply` 可用；`build-packages` 已能构建已迁移包；`image` 仍未实现。

## 前置

- Node.js 24（当前 Plus CI）
- pnpm 11.28.5
- Docker（只用于镜像阶段）
- 官方源码按 `downstream/upstream.lock.json` 固定到 `dsh-v0.2.3-alpha.2`

## 最小命令

```bash
git clone git@github-sparkelf:SparkElf/deepseek-harness-plus.git
cd deepseek-harness-plus
pnpm install --frozen-lockfile

# 查看当前锁定的官方 revision、Plus 版本、profile pin 数量
node downstream/tools/downstream.mjs status

# 需要拉官方 tag 时
node downstream/tools/downstream.mjs sync --fetch

# 校验 upstream.lock + release-manifest + Plus governance
node downstream/tools/downstream.mjs verify
```

## 迁移完成后

构建已迁移包：

```bash
node downstream/tools/downstream.mjs build-packages
```

应用补丁和 profile（需要官方 DSH root）：

```bash
node downstream/tools/downstream.mjs apply --dsh-root /path/to/official-dsh
```

`image` 需要外部 builder：先运行 `image-plan` 生成确定性输入（包含 `localPackages` workspace 覆盖），再设置 `DOWNSTREAM_IMAGE_BUILDER` 指向接受 `--release-manifest <path>` 的 builder。没有 builder 时 fail closed，不会伪造镜像。

`publish` 在 npm provenance 和 release workflow 验收前保持禁用。

`apply` 委托给构建后的 `packages/bundle/plus/lib/bin.js apply`；如果该文件不存在，先运行 `pnpm --filter @sparkelf/dsh-plus run build`。

## 可复现构建契约

clean fork 要能复现镜像，至少需要：

- `downstream/upstream.lock.json` 的 revision 可获取；
- 根 `pnpm-lock.yaml` 完整，`pnpm install --frozen-lockfile` 可跑；
- `downstream/release-manifest.json` 锁定镜像使用的精确版本；
- `downstream/tools/downstream.mjs` 不依赖本机手工 tarball；
- 镜像 builder 只消费 release manifest，不读取“当前工作树里碰巧有什么”；
- 构建阶段不需要部署密钥；
- `infra/docker-workspace/README.md` 和 `docs/guide-intranet-image-update.md` 同步更新。

当前还没有满足以上全部条件；`BUILD.md` 会随迁移进度更新，不能把 scaffold 命令当成完整镜像复现。
