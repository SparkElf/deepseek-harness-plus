# DSH Plus Monorepo Build

状态：migration 阶段（26 migrated / 1 excluded / 0 blocked）。`status` / `sync` / `verify` / `apply` / `build-packages` / `profile` / `image` 可用；镜像 builder 已能生成并 smoke-gate 本地 DSH 镜像，生产化 overlay 仍待补。

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

# 生成可部署的 profile（约 564MB，包含 workspace 本地包）
node downstream/tools/downstream.mjs profile --out /tmp/dataops-web-profile

# 检查 clean fork 的前置文件、tag、lockfile、profile 和嵌套 workspace
node downstream/tools/downstream.mjs doctor

# profile 是从 release manifest 生成的，不要手改依赖版本
ls downstream/profiles/dataops-web/{package.json,profile.json}

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

`image` 需要外部 builder：先运行 `image-plan` 生成确定性输入（包含 `localPackages` workspace 覆盖和 `localPackagePolicy`），再设置 `DOWNSTREAM_IMAGE_BUILDER` 指向接受 `--release-manifest <path>` 的 builder。没有 builder 时 fail closed，不会伪造镜像。

`publish --dry-run` 校验已迁移包的 name/version 和构建入口；真正的远端发布仍 fail closed，需要独立 release 审批与 npm provenance。

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

## Profile artifact scope

`downstream profile` produces the profile install set (package + node_modules + cordis files),
not a standalone DSH installation. Do not test it with `dsh --profile dataops-web web` from an
unrelated DSH home: that selects the CLI's own built-in profile tree and cannot resolve the
DataOps bundle graph. The image builder must combine this artifact with the pinned DSH
installation and the Plus distribution, then run it from the image's own `DSH_HOME`.
