# 工作区镜像构建

[English](README.md) | 中文

状态：DataOps AI 工作区镜像构建链的骨架，在 B-08 任务中从 `dataops/infra/docker-workspace` 迁入。Dockerfile、构建脚本和构建期输入按字节镜像，构建计划可解析。干净 clone 仍无法产出镜像：8 个必需输入只被列出，并未随仓库提供。DataOps 仍拥有生产构建，这里没有任何内容被部署。

## 目录结构

```text
images/workspace/
├── README.md                  this file
├── inputs.lock.json           digests of the mirror and of the artifacts a build must supply
├── context/                   docker build context, mirrors infra/docker-workspace
│   ├── Dockerfile             base layer (Node 26 + Python 3.12 + LibreOffice + Playwright)
│   ├── Dockerfile.plus-cli-src  source-deps + plus-build
│   ├── Dockerfile.runtime-cli   runtime layer
│   ├── apply-plus.sh          source patches, one official build, gates, profile install
│   └── ...                    scripts and inputs copied by those three files
├── scripts/
│   ├── build-workspace-final.sh  three-layer build entry
│   ├── prepare-inputs.sh         supply and verify the untracked build artifacts
│   └── check-parity.sh           digest comparison against the DataOps source tree
└── acceptance/
    ├── baseline-20261126.json    B-07 measurements, targets, and unmeasured items
    └── verify-workspace-image.mjs  boot and plugin acceptance probe
```

复制的路径保留 DataOps 原名，因此三个 Dockerfile 里的每个 `COPY` 都无需修改构建定义即可解析。重命名为所有权设计中的 `Dockerfile.base` / `Dockerfile.plus` / `Dockerfile.runtime` 布局留到后续步骤；此刻改名等于用字节级一致性换命名整齐，而正是这份一致性检查让重复的构建上下文处于可控状态。

| DataOps 路径 | 此处 |
| --- | --- |
| `infra/docker-workspace/Dockerfile` | `context/Dockerfile` |
| `infra/docker-workspace/Dockerfile.plus-cli-src` | `context/Dockerfile.plus-cli-src` |
| `infra/docker-workspace/Dockerfile.runtime-cli` | `context/Dockerfile.runtime-cli` |
| `infra/docker-workspace/build-workspace-final.sh` | `scripts/build-workspace-final.sh` |
| `infra/docker-workspace/verify-workspace-image.mjs` | `acceptance/verify-workspace-image.mjs` |
| `infra/docker-workspace/*.sh`、`*.py`、`*.mjs`、`profile-defaults/`、`officecli/` | `context/` 下的相同相对路径 |

## 构建链

```text
base            Dockerfile --target workspace-base
                Python 3.12 + Node 26.13.1 + npm 12 + LibreOffice 25.8.7
                + Playwright 1.57.0/Chromium r1200 + OfficeCLI + Python libraries
  -> source-deps  Dockerfile.plus-cli-src stage 1: unpack dsh-src.tar.gz, pnpm install
  -> plus-build   stage 2: Plus tarball metadata edits, global install, apply-plus.sh
                  (source patches -> one official build:official -> run-gates -> profile install)
  -> runtime      Dockerfile.runtime-cli: entrypoint, workspace gateway, dataops-dsh-service, sshd
  -> final-YYYYMMDD-HHMM, plus final and local aliases
```

base 不安装任何 DSH 包。profile 只在 `plus-build` 中装配一次，runtime 层只补运行时文件；改 gateway 或 entrypoint 不会重建 DSH 树。LibreOffice 放在 base，Plus 重建因此复用该层，不再重复下载 790MB。

## 构建

```bash
cd images/workspace

# Resolve every command and list missing inputs; never builds.
./scripts/prepare-inputs.sh
./scripts/build-workspace-final.sh 0.2.9-alpha.106 --print

# Full build, once the eight inputs are supplied.
./scripts/build-workspace-final.sh 0.2.9-alpha.106
```

脚本按镜像 ID 串接各层，传 `--network host`，并写出 `dataops-ai-workspace:base-py312`、`:plus-cli-py312-<version>`、`:runtime-files`、`:final-<stamp>`、`:final` 与 `:local`。用 `IMAGE_REPOSITORY` 可换一个仓库名构建。

| 变量 | 含义 |
| --- | --- |
| `WORKSPACE_GATEWAY_PROTOCOL_CONTEXT` | DataOps 的 `packages/workspace-web-gateway-protocol`，作为命名构建上下文 `workspace-web-gateway-protocol` 传入；缺省回退到 `DATAOPS_WORKSPACE_DIR/packages/workspace-web-gateway-protocol` |
| `DSH_PLUS_TARBALL` | Plus 发行 tarball；默认 `context/sparkelf-dsh-plus-<version>.tgz` |
| `DSH_SOURCE_REVISION` | 源码 tarball 所切的官方 DSH revision |
| `DSH_SOURCE_REGISTRY`、`DSH_PLUS_INSTALL_REGISTRY` | 源码安装与 Plus 安装使用的 npm 镜像 |
| `DATAOPS_PROFILE_DEFAULTS` | Provider 目录：云端镜像用 `cordis.patch.yml`，自托管 arm 盒子用 `cordis.local-qwen.patch.yml` |
| `SKIP_BASE=1` | DSH 单独升级时复用现有 `base-py312` 镜像 |
| `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` | 透传给 Plus 阶段 |

## 缓存

`source-deps` 是真实的缓存边界：它只依赖 `dsh-src.tar.gz`、lockfile 与 vendored `xlsx` tarball，所以只改 Plus pin 时会复用 2.46GB 的安装层。6 个 BuildKit cache mount 把包存储挡在镜像层之外：

| Cache id | 路径 | 使用方 |
| --- | --- | --- |
| `dsh-pnpm-store` | `/root/.local/share/pnpm/store` | source-deps、plus-build |
| `dsh-pnpm-meta` | `/root/.cache/pnpm` | source-deps、plus-build |
| `dsh-npm-cache` | `/root/.npm` | Plus 全局安装、apply |
| `dataops-workspace-npm` | `/root/.npm` | base npm 阶段、Playwright |
| `dataops-workspace-pip` | `/root/.cache/pip` | base Python 包 |
| `dataops-sidecars-npm` | `/root/.npm` | sidecar 安装 |

这些缓存都在宿主机本地。没有 `docker buildx bake`、没有 registry cache、没有多架构构建定义；换一台机器就是冷构建。见[迁移缺口记录](../../docs/workspace-image-migration-gap.zh.md)。

## 验收

体积只用一种口径测量并注明：`docker images` 的可见大小是设计文档使用的数字，`docker history` 是层差之和，`inspect .Size` 近似拉取量。候选镜像不得超过生产行；最新构建行用来证明 2026-11-25 的瘦身没有回退。

| 指标 | 目标 | 2026-11-26 基线 |
| --- | --- | --- |
| 最终镜像 `docker images` | <= 13.2GB（生产），软目标 11.9GB | 生产 13.2GB，最新构建 11.9GB |
| Plus 层增量 | 比 LibreOffice 迁入 base 前低 >= 700MB | plus 11.5GB，base 4.84GB |
| 可写层 | < 50MB，测量前排除 `/tmp/dsh-workspace-changes-*` | 2.2GB，其中约 2.09GB 是运行期 `/tmp` |
| 每用户 `/workspace` volume | < 2GB | 3.2GB |
| 只改 pin 构建 | <= 5 分钟，`apply-plus.sh` 拆分前无法达到 | 未测 |
| 源码/patch 构建 | 热缓存 <= 15 分钟 | 未测 |
| base 构建 | 热缓存 <= 25 分钟 | 未测 |
| DSH ready | 热节点 10-15 秒，冷节点 30-60 秒 | 未测 |
| 运行时探针 | `node -v` v26.13.1、LibreOffice 25.8.7.3、DSH 0.2.3-alpha.2、Plus 0.2.9-alpha.105、26 bundles、19 个中文字体、`dataops-dsh-service status` ready | 生产容器一致 |

`acceptance/verify-workspace-image.mjs` 起临时容器检查启动、插件成员与路由，结束后删除。`acceptance/baseline-20261126.json` 保存完整数字、三种体积口径，以及从未采集的项。

## DataOps 仍负责的部分

- 部署镜像引用：`DATAOPS_AI_WORKSPACE_DOCKER_IMAGE` / `operations_workspace_hosts.workspace_image`。
- `/workspace` named volume、`3080` 端口、容器网络，以及运行期 overlay 挂载。
- 门户侧工作区的 `ensure` / `health` / `restart`，以及决定 sshd 何时可达的隧道策略。
- 运行时配置与密钥：模型凭据、租户覆盖、`/run/dataops-workspace` 下的内部 token。
- 回滚 tag、发布审批、registry 推送，以及 3000 切换与回滚演练。

## 构建上下文输入

`inputs.lock.json` 是两半的摘要权威：镜像进来的文件，以及构建必须提供的产物。`scripts/prepare-inputs.sh` 从 `DATAOPS_WORKSPACE_DIR` 或公开源生成 DSH 源码 tarball、Plus tarball 和 6 个 `vendor/` tarball 并逐一校验；`--check` 只校验不写文件。OfficeCLI 引擎二进制可选，因为引擎阶段会自行下载并校验。

## 迁移期一致性

```bash
./scripts/check-parity.sh --dataops /root/projects/dataops/infra/docker-workspace
```

该检查按内容比对每个镜像文件，并报告必须保持缺席的 6 个产物。B-10 删除 DataOps 构建实现之前，任何镜像文件的改动都必须在同一次变更中落到两边；有了这个检查，这条规则才是可执行的，而不只是口头约定。