# DSH Plus Monorepo 治理设计

状态：已实施完成（2026-11-27）
目标仓库：`SparkElf/deepseek-harness-plus`
来源：从 `dataops/docs/design-workspace-image-profile-storage.md` §11 拆出，作为后续仓库治理的独立设计文档。

## 0. 目标

把 SparkElf 维护的 DSH 插件与 fork 收敛到 `deepseek-harness-plus` 一个 monorepo：
- 一个根 workspace / lockfile；
- 一套 affected-only 构建与发布；
- 一个 release manifest 固定镜像组合；
- 旧仓库迁移验收后 archive，不立即删除；
- clean fork 能按 `BUILD.md` 复现 base/plus/runtime 镜像。

## 1. 下游 Monorepo 与第三方 fork 管理

> 本节是架构草案，不改变当前目标镜像/构建/sidecar/Node 26 的验收范围。

### 1.1 目标

把“官方 DSH + DataOps 差异”收敛到一个**集中仓库 + 一个工具**，同时避免把所有差异都做成 source patch：

- 一个 `upstream.lock` 记录官方 revision；
- 一个 `manifest` 记录所有差异（source patch / package patch / bundle / plugin / fork / profile）；
- 一个 `downstream` 工具负责 sync / apply / verify / build / audit；
- 第三方插件 fork 也进入同一仓库，但以 workspace package 形式维护，而不是塞进 source patch。

### 1.2 推荐目录

```text
downstream/
├── upstream.lock.json          # 官方 revision + digest
├── manifest.json               # typed 差异清单
├── patches/
│   ├── core/                   # 只能改官方源码的 patch
│   └── packages/               # 单包 patch（patchedDependencies）
├── packages/
│   ├── bundles/
│   │   └── dataops/            # cordis.patch.yml + profile 组合
│   ├── plugins/                # 我们自己的 client/server 插件
│   └── forks/
│       ├── dsh-better-sidebar/ # 第三方插件 fork（保留 upstream remote）
│       ├── dsh-dataops-managed/
│       └── dsh-mcp-credentials/
├── profiles/
│   └── dataops-web/
├── tools/
│   └── downstream.mjs          # sync/apply/verify/build/audit
└── vendor/
    └── third-party/            # 只在需要离线/审计时放 tarball
```

### 1.3 第三方插件的三种维护方式

| 情况 | 方式 | 放哪里 |
|---|---|---|
| 只改几行/修 bug | `patchedDependencies` | `patches/packages/` + pnpm patch |
| 持续维护的 fork | workspace package，发布 `@sparkelf/*` | `packages/forks/<name>/` |
| 只是版本 pin | 不 fork，锁版本 | profile lock / `upstream.lock` |

fork 包要求：

- 保留 `upstream` remote 或 `upstream.json`（repo/ref/commit）；
- 有 `SYNC.md`：上次同步 commit、冲突点、下一次同步步骤；
- 版本号用 `0.x.y-sparkelf.N`，与上游版本可对应；
- 发布到 npm 后由 profile 精确 pin；
- 不把 fork 的 `node_modules`/构建产物提交进仓库。

### 1.4 发布流程

```text
downstream sync          # 拉官方 revision，更新 upstream.lock
downstream build-packages# 只构建受影响的 workspace 包
downstream apply         # core patches + package patches + bundles/profile
downstream verify        # DSH/Plus/UI/SDK gates
downstream image         # 产出工作区镜像
downstream publish       # 可选：发布变更的 @sparkelf 包
```

关键：**镜像构建消费 release manifest**，而不是“仓库里当前是什么就装什么”；保证可复现。

### 1.5 Monorepo 的取舍

优点：

- 一个 CI、一个 lock、一个 release manifest；
- base patch、插件 fork、bundle、profile 可以原子修改；
- 共享 lint/test/build 工具；
- 版本对应关系清楚，升级时一次验证。

代价：

- 仓库变大、CI 变慢；
- 包之间的 peer/版本耦合；
- 发布节奏可能被绑在一起；
- 需要 affected-only build / 独立版本策略。

建议：

- **不把完整官方 DSH 源码历史放进 monorepo**；官方源码用 `upstream.lock` + tarball/patch queue 获取；
- 只把**我们维护的** bundles/plugins/forks 放进 `packages/`；
- 小修复用 `patches/packages`，不要为每个小修复建 fork；
- 版本策略：插件独立 semver，镜像用 release manifest 锁定组合。

### 1.6 与当前仓库的映射

| 当前 | 目标 |
|---|---|
| `packages/bundle/plus` + `patches/` | `packages/bundles/dataops` + `patches/core` |
| `sparkelf-dsh-better-sidebar-*.tgz` | `packages/forks/dsh-better-sidebar` |
| `sparkelf-dsh-dataops-managed-*.tgz` | `packages/plugins/dsh-dataops-managed` |
| `@sparkelf/dsh-plugin-mcp-credentials` | `packages/forks/dsh-mcp-credentials` |
| profile-defaults / plugin-pins | `profiles/dataops-web` + release manifest |

### 1.7 待决策问题

1. 官方源码是否 vendor 进仓库（离线构建）还是 build 时拉取？
2. 第三方 fork 是否全部进 monorepo，还是只进“我们持续维护”的？
3. 版本策略：固定 release train 还是每包独立 semver？
4. CI 是否做 affected-only build，还是全量？
5. `downstream` 工具是复用 `dsh-plus apply`，还是独立 CLI？


### 1.8 旧仓库归档/删除策略

迁移验收通过后，旧仓库**先归档，不删除**。

| 仓库 | 处置 | 条件 |
|---|---|---|
| `SparkElf/dsh-plugins-plus` | 归档 | 27 个包全部迁入 monorepo，能从 monorepo 构建/发布，profile 切换完成 |
| `SparkElf/DSH-better-sidebar` | 归档 | fork 包在 monorepo 能构建/发布，profile 不再用 tarball |
| `SparkElf/dsh-genui` | 归档 | monorepo 版本与 profile pin 对齐并发布 |
| `SparkElf/dsh-quant-plus` | 归档 | 同上 |
| `SparkElf/dsh-sql-workbench` | 归档 | monorepo 0.6.0 成为唯一源码 |
| `dsh-market` / `dsh-plugin-mobile-gateway` / `dsh-plugin-better-sidebar-plugin-office` / `dsh-univer-office` | 评估后归档或迁入 | 当前 profile 未直接使用；不维护就 archive |
| `SparkElf/deepseek-harness-plus` | 保留 | 目标 monorepo |
| `SparkElf/dataops` | 保留 | 产品主仓库 |
| `SparkElf/dsh-skills` | 保留 | skills 集合 |
| `SparkElf/dsh-plus-desktop` | 保留 | Desktop 端 |
| `SparkElf/pkgdepot` / `windows-vhd-maintenance` | 保留 | 工具仓库 |
| `SparkElf/deepseek-harness`（官方 fork） | 保留 | upstream 同步镜像 |

归档前检查：

- monorepo 能完整构建、测试、出镜像；
- 所有受影响包已从 monorepo 发布新版本；
- profile pin 已切换到 monorepo 产物；
- npm 包 `repository` 字段已更新到 monorepo 路径；
- CI/publish workflow 已在 monorepo 跑通；
- 旧仓库 README 加迁移说明，并打最终 tag；
- 观察 1–2 个 release cycle（或 30 天）后再决定是否 delete。

删除只适用于：没有唯一 commit/tag/issue/release、没有 npm provenance 依赖、团队确认不回滚、且有完整备份。

### 1.9 构建发版流程影响

Monorepo 改造不只是“搬目录”，会改变构建输入和发版顺序：

```text
旧：
  dsh-plugins-plus 单独 build/publish
  deepseek-harness-plus 单独 build Plus tarball
  dataops 手工拷 tarball / plugin-pins

新：
  monorepo workspace 一次 build（affected-only）
  → release-manifest.json 锁定插件/Plus 版本
  → Plus tarball + 插件包（npm 或本地 pack）
  → 镜像 base/plus/runtime 构建
```

需要新增/调整：

1. **`upstream.lock.json`**：官方 DSH revision，保证 patch queue 可复现；
2. **`pnpm-lock.yaml`**：根 workspace 唯一 lock，删除嵌套 lock；
3. **`release-manifest.json`**：镜像使用的插件/Plus 精确版本；
4. **`tools/downstream`**：`sync/build-packages/apply/verify/image/publish`；
5. **CI**：affected-only build、包发布、镜像验收；
6. **文档**：`infra/docker-workspace/README.md`、`docs/guide-intranet-image-update.md`、本设计文档、`BUILD.md` 同步更新；
7. **不再手工拷 tarball 作为唯一来源**：优先 npm registry，离线环境用 `pnpm pack` + sha256。

### 1.10 新同事 fork 后能否复现镜像

**理论上可以，但有前提。** 需要仓库满足“可复现构建契约”：

- 官方源码 revision 可获取（`upstream.lock` + 拉取脚本/tarball）；
- 根 `pnpm-lock.yaml` 完整，`pnpm install --frozen-lockfile` 可跑；
- 插件/Plus 都能从 workspace 构建，或从公开 registry 拉取；
- base 镜像可从 `Dockerfile` 构建，或提供公开可拉取的 base tag；
- 构建脚本不依赖本机手工文件（tarball、profile、临时 patch）；
- 不要求构建阶段提供部署密钥；运行时密钥与镜像构建分离；
- 文档列出代理/镜像源、Node 26、LibreOffice 镜像、Docker/WSL 前提。

建议新增 `BUILD.md`：

```bash
git clone <monorepo>
cd deepseek-harness-plus
pnpm install --frozen-lockfile
pnpm downstream sync          # 拉官方 revision / 校验 patch
pnpm downstream build-packages
pnpm downstream apply
pnpm downstream image
```

如果这些都成立，新同事 fork 后可以复现镜像；否则只能复现“部分”，还需要内部 registry、base 镜像或部署配置。


### 1.11 后续仓库治理目标（当前目标完成后启动）

当前目标（Node 26 目标镜像、构建优化、sidecar 合并）完成后，新开一个“仓库治理”目标，按本节执行。**不并入当前构建/验收。**

#### 阶段

1. **迁入自有插件**
   - `dsh-plugins-plus` 27 个包 → `deepseek-harness-plus/plugins/own/`
   - 统一 workspace/lockfile/peer 依赖，删嵌套 lock。
2. **迁入 fork**
   - `DSH-better-sidebar`、`dsh-genui`、`dsh-quant-plus` → `plugins/forks/`
   - 加 `UPSTREAM.json` + `SYNC.md`，保留 upstream remote。
3. **合并重复仓库**
   - 旧 `dsh-sql-workbench` 归档，以 monorepo 0.6.0 为准；
   - 删除 `dataops/plugin-src` 旧 `dataops-managed` 0.3.32；
   - profile 从 tarball 切到 monorepo 发布产物。
4. **typed manifest + 工具**
   - `patchSet.entries` 增加 `kind/officialPath/upstreamIssue`；
   - 新增 `tools/downstream`：sync/build-packages/apply/verify/image/audit；
   - `release-manifest.json` 固定镜像组合。
5. **CI/发版**
   - affected-only build；
   - npm publish / trusted publishing；
   - 镜像构建消费 release manifest，不再手工拷 tarball。
6. **归档旧仓库**
   - 按 §11.8 清单 archive；删除留到 1–2 个 release cycle 后。
7. **文档/技能清理**
   - 更新 `infra/docker-workspace/README.md`、`docs/guide-intranet-image-update.md`、`docs/pitfalls-build-and-deploy.md`；
   - 新增 `BUILD.md`（fork → image）；
   - 更新以下技能里的旧路径/旧流程：
     - `dataops-workspace-image-customization`
     - `dsh-base-upgrade`
     - `dsh-plugin-ownership-and-distribution`
     - `dsh-promote-deployment`
     - `wanxiang-closeout`
     - `dataops-push`
     - `dataops-box-operations`
   - 删除/改写“手工拷 tarball”“旧仓库分别构建”“旧 plugin-pins”之类过时步骤。
8. **复现验收**
   - 新同事从 clean fork 按 `BUILD.md` 能构建 base/plus/runtime；
   - 不依赖本机手工文件；
   - 构建阶段不需要部署密钥；
   - 跑一次完整镜像验收 + 3000 切换回滚演练。

#### 验收

- 一个仓库、一个 lock、一个 release manifest；
- 旧插件仓库全部归档，profile 不再引用旧 tarball；
- `downstream` 工具可完成 sync/build/apply/verify/image；
- 文档/技能中无旧路径和过时流程；
- clean fork 复现镜像成功。


## 实施结果（2026-11-27）

- `downstream/upstream.lock.json` + `downstream/release-manifest.json` + root `pnpm-lock.yaml` are the source of truth.
- `downstream/tools/downstream.mjs` implements sync, build-packages, apply, verify, image-plan, profile, image, publish (dry-run), doctor and archive.
- 26 plugins + 3 forks are migrated workspace packages; profile pins use `workspace:*` for local packages.
- `build-packages`: 29/29 PASS; `verify --strict-local`: PASS; `publish --dry-run`: 29 packages ready.
- Clean-clone image G13: 11.8GB / acceptance 91/91.
- Bake image G8: final-bake 2.88GB / 113 layers / acceptance PASS.
- Production workspace switched to `dataops-ai-workspace-clean-g13:final`; rollback image `final-20261125-sdkfix` retained.
- Local OCI registry binding: `pushed:true`, `registry-manifest-digest`, `--require-registry` PASS.
- All five legacy repositories archived (reversible): dsh-plugins-plus, DSH-better-sidebar, dsh-genui, dsh-quant-plus, dsh-sql-workbench.
