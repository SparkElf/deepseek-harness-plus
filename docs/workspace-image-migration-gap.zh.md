# 工作区镜像迁移缺口

[English](workspace-image-migration-gap.md) | 中文

状态：B-08 任务的迁移记录，2026-11-26。记录 monorepo 骨架 [images/workspace](../images/workspace/README.zh.md) 尚未具备的东西，让后续任务逐项关闭，而不是重新发现。B-10 完成镜像所有权切换后删除本记录。

## 范围

骨架按字节镜像了 DataOps 的构建上下文，并能解析构建计划。它不产出镜像：8 个输入按设计缺席，其中一个无法镜像，因为 DataOps 自己没有纳入版本控制。下面的记录把「构建需要的输入」「从未完成的构建语义」「尚不存在的证据」分开列出。

## 缺口清单

| ID | 缺口 | 证据 | 影响 | 下一步 |
| --- | --- | --- | --- | --- |
| G1 | `dsh-src.tar.gz` 未纳入版本控制 | `dataops/.gitignore:109` 忽略 `infra/docker-workspace/dsh-src*.tar.gz`；文件 112,053,351 字节，SHA-256 `beb37625…2c41` | 干净 clone 无法执行 `source-deps`；从别的 commit 重打 tarball 会让每个源码补丁锚点位移 | 把 tarball 作为与 `DSH_SOURCE_REVISION` 绑定的 release 产物发布，或在预检步骤拉取并校验 |
| G2 | `platform-sidecars/workspace-gateway.mjs` 未跟踪 | `git status` 报 `?? infra/docker-workspace/platform-sidecars/workspace-gateway.mjs`；2,327 字节，SHA-256 `8bb74de4…7afab`；`Dockerfile.runtime-cli:41` 复制它 | runtime 构建停在该 `COPY`；只构建 plus 层会得到三个 sidecar 而不是四个，且 entrypoint 默认 `combined` 模式 exec 同一个缺失文件，这样的镜像会没有网关就启动 | 在 DataOps 提交该文件。镜像无法凭空造出合并网关，放占位文件只会掩盖失败 |
| G3 | 网关协议构建上下文属于 DataOps | `build-workspace-final.sh` 传 `--build-context workspace-web-gateway-protocol=…/packages/workspace-web-gateway-protocol`；`backend/src/ai/ai-workspace-web-gateway.service.ts` 导入同一个包；monorepo 没有该包 | monorepo 构建需要第二个 checkout，线协议没有唯一所有者 | 决定协议归属：把协议迁入 monorepo 并让 DataOps 消费，或在锁文件中固定 DataOps revision 并校验其摘要 |
| G4 | Plus tarball 与 `vendor/` tarball 未纳入版本控制 | `dataops/.gitignore:112`；`vendor/` 有 13 个 tarball，约 39MB，其中 4 个被 Dockerfile 按摘要引用 | 干净 clone 无法执行 `plus-build`；`npm pack` 在构建期需要 registry 凭据 | 存为 release 产物，或在预检中拉取并按 [inputs.lock.json](../images/workspace/inputs.lock.json) 校验 |
| G5 | 两个更旧的构建入口与三层链矛盾 | `build-image.ps1` 不带 `--target` 构建 `Dockerfile` 并把它 tag 成 `local`，而该文件最后一个 stage 是 `workspace-base`。`build-plus-cli.sh` 构建 `Dockerfile.plus-cli`，即没有 `source-deps`、没有 `apply` 的 registry 安装链。`dataops/AGENTS.md` 仍把 `build-image.ps1` 写成完整重建入口 | 审阅者可能把 base 镜像当 `final` 发布，或构建出不含源码补丁的 plus | 在 DataOps 标记两者废弃，只保留 `build-workspace-final.sh` |
| G6 | 「只改一个 pin，5 分钟重建」无法达到 | `apply-plus.sh:103` 一条 `dsh-plus apply` 同时打补丁、构建、安装 profile；该层 1.11–1.68GB。设计要求拆分需要 `--skip-build` 模式 | 按该目标验收必然失败，而为了达标容易仓促改构建语义 | 拆开 `source-build` 与 `profile`，或在拆分落地前把目标改写为「`source-deps` 命中，`apply` 仍执行」 |
| G7 | runtime 裁剪从未实现 | 三个 Dockerfile 与 `apply-plus.sh` 中没有 `pnpm deploy --prod` 或 `pnpm prune --prod`；生产镜像保留 `/opt/dsh-source` 2.9GB、`/opt/dsh-home` 804MB、模板 804MB、运行 profile 804MB；profile 包软链进 `/opt/dsh-source` | 2–4GB 的 runtime 目标不能靠删目录达到，粗暴裁剪会破坏 profile 解析 | 证明 DSH 运行时实际解析哪些路径，再只裁那些，作为带独立验收的单独变更 |
| G8 | 没有 bake 定义、registry cache 或多架构构建 | 仓库没有 `docker-bake.hcl`；6 个宿主机本地 BuildKit cache id；全部镜像为 amd64 | 换机器即冷构建：2.46GB 安装加 1.11GB apply；CI 无法共享缓存 | 在显式开关后加 bake target 与 registry cache，并在第二台机器上对比冷构建基线 |
| G9 | 镜像 digest 与发布绑定不存在 | `RepoDigests` 只有本地伪 digest，从未 push。生产镜像的 `DATAOPS_DSH_SOURCE_REF` 为空，而 profile ref 有值 | 已部署镜像无法追溯到产出它的构建 | 在一份 manifest 中记录 source ref、Plus 版本与镜像 digest，并在构建期断言非空 |
| G10 | 两个都成立的基线相差 1.3GB | 生产 `final-20261125-sdkfix` 为 13.2GB，含 Debian LibreOffice 7.4 与 TDF 解压；`local` 为 11.9GB，含 TDF apt 安装与裁剪 | 「不劣化」没有唯一含义 | 候选镜像同时对比两行；[baseline-20261126.json](../images/workspace/acceptance/baseline-20261126.json) 两者都记录 |
| G11 | 可写层测量被运行期污染 | `docker ps -s` 报 2.2GB，其中约 2.09GB 是运行容器产生的四个 `/tmp/dsh-workspace-changes-*` 快照 | 镜像再小，`<50MB` 目标也会失败 | 排除运行期 `/tmp` 后再测量，并单独调查快照的生产者 |
| G12 | 骨架保留 DataOps 文件名，而非设计布局 | 本次把 `Dockerfile`、`Dockerfile.plus-cli-src`、`Dockerfile.runtime-cli` 原样放在 `context/`；所有权设计叫 `Dockerfile.base`、`Dockerfile.plus`、`Dockerfile.runtime` | 在改名发生前，目录树与设计目标不一致 | 与入口脚本重写同批改名，并在同一变更中更新一致性检查 |
| G13 | 从未演示过 clean-clone 构建 | B-07 把耗时、摘要与 clean-clone 构建记为未采集；当前构建需要宿主路径、本地镜像与凭据 | 「可复现」只是声明，不是证据 | 解决 G1–G4 后，在新机器的全新 clone 上构建，并记录镜像 digest 与分阶段耗时 |

## 本骨架做出的决定

- 镜像而非重写：三个 Dockerfile 与每个复制进来的输入保持字节一致，因此 [check-parity.sh](../images/workspace/scripts/check-parity.sh) 能证明等价，审阅者也能直接 diff，不必翻译。
- 不伪造产物：占位说明与 `inputs.lock.json` 列出缺失项。缺失的网关文件保持缺失，让 runtime 构建在 `COPY` 处失败，而不是产出一个没有网关的镜像。
- 失败关闭：构建入口用 `--print` 打印解析后的计划；真正构建时带着完整输入清单非零退出。唯一的跨仓库路径是一个显式环境变量。
- 迁移期保留 `dataops-ai-workspace` tag 命名空间，因为候选镜像必须能与记录的基线对比。改名属于 release manifest 的工作。
- 验收数据以 JSON 加显式 null 记录，不用散文。未测的数字保持 `null` 并写明原因。

## 下一步

| 任务 | 工作 | 完成判据 |
| --- | --- | --- |
| B-08 剩余 | 在 DataOps 提交 `workspace-gateway.mjs`；发布 DSH 源码与 Plus tarball；决定网关协议归属 | `check-parity.sh` 通过，`--print` 报告无缺失输入 |
| B-09 | 在独立主机上用新 tag 构建候选镜像；跑 `verify-workspace-image.mjs`；记录体积、分阶段耗时与运行时版本；演练 3000 切换与回滚 | 候选满足生产行，运行时探针一致，并演示回滚到 `final-20261125-sdkfix` |
| B-10 | 把 DataOps 构建实现降级为 DEPRECATED，部署引用改为 digest，退役重复上下文 | DataOps 只剩部署引用，本记录被删除 |

仓库要求非平凡变更附带 Agent Note。本任务禁止提交，因此该 note 随采用本骨架的 PR 一起落地，而不是随这些文件。

## 切换前不能做的事

- 3000 切换与回滚演练成功前，不删除、不改写 DataOps 构建文件。
- 不 prune、不重打 `final-20261125-sdkfix`；它是唯一的回滚目标，`local` 不是生产镜像。
- 不把 `local` 当基线；它比生产实际运行的镜像小 1.3GB。
- 在证明 DSH 解析哪些路径之前，不为达到 2–4GB 目标裁剪 runtime 镜像。

## 溯源

源码树 `dataops`，commit `e5c411e68e83cd3e03897af3c0a6cefca50d3e39`，采集于 2026-11-26。三个 Dockerfile 的摘要与 B-07 基线一致（`413bbee8…`、`bada4021…`、`0fc4b5eb…`）。文件级摘要与预期产物摘要见 [inputs.lock.json](../images/workspace/inputs.lock.json)；测量与目标见 [baseline-20261126.json](../images/workspace/acceptance/baseline-20261126.json)。