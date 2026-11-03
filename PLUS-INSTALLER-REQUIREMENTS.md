# DSH Plus 安装器与版本清单：需求记录

> 来源：用户 2026-10-30 的连续澄清。此文件是当前需求的单一来源；实现、文档、验收与本文件冲突时，以本文件为准。

## 1. 三层架构（不是四层）

1. **DSH Plus**：官方 DSH 的唯一 patch 层；底座能力增强；安装器 CLI。
2. **第三方插件或 fork**：上游原样使用；需要改时用我们的 fork（独立插件包，不是 patch 层）。
3. **自研插件**：自己的功能/UI/设置/路由；消费 Plus 能力，不 patch 官方包。

## 2. 只有 DSH Plus 有 patch

除了 DSH Plus 本身，没有其他地方维护 patch。部署脚本、第三方插件、fork、自研插件都不再各自维护补丁清单。

## 3. CLI 与版本清单

- 入口：`npx @sparkelf/dsh-plus install --edition personal|team`。
- CLI 直接维护 profile 的 `package.json`；**没有 standalone 包**。
- personal 与 team 是**不同的清单**，安装不同的插件集合。
- 版本只选择 plugins/bundles，不改变 patch set；所有版本共享同一条 `dshPlus.patchSet`。

## 4. 清单只包含什么

**只包含：**

- 第三方插件；
- 第三方插件的 fork；
- 我们自研的插件。

**不包含：**

- 官方 DSH base 包（`@deepseek-ai/dsh`、`dsh-base`、`dsh-web-app`、官方 experimental bundles 等）——这些由 CLI 作为底座安装；
- DSH Plus 自己的 patch 产物（republished `@sparkelf/*`）——这些由 patch set / overrides 处理。

## 5. 正确安装流程

`npx @sparkelf/dsh-plus install --edition team` 应完成三步：

1. 安装 DSH base（官方运行时的固定底座）。
2. 应用 DSH Plus patch set（republished `@sparkelf/*` + profile `overrides`）。
3. 安装 edition 清单中的第三方/fork/自研插件。

## 6. 容器

DataOps 8080 容器按 **team edition** 安装。不允许手工复制模板、手工改 profile 来替代 CLI 安装；手工操作只用于故障恢复，不算交付。

## 7. 网络

安装遇到网络错误或超时，自动切换大陆镜像（`https://registry.npmmirror.com`）。优先顺序按 locale 决定；`DSH_PLUS_INSTALL_REGISTRY` 可覆盖。每次尝试有超时，失败后换下一个源。

## 8. 验收

不能只验收“包装上了”。team edition 的**每个插件都必须启用/挂载**：

- 包在 profile 的 `node_modules` 中；
- bundle 在 `dsh.profile.bundles` 中；
- `--dump-config` 能看到对应行；
- 启动日志没有 `skipping profile bundle` / `disabling profile plugin row`；
- allow 审批生效；
- image-hoist / session-query 的补丁行为落地（例如 `replayMessageProjections` 存在）；
- 页面可用。

## 9. 当前阻塞

team 清单里有几个插件没有发布到 npm，CLI 的安装会在解析阶段失败：

| 包 | 状态 | 处理 |
| --- | --- | --- |
| `@sparkelf/dsh-dataops-account@0.2.0` | npmjs/npmmirror 404；源码在 `dsh-plugins-plus/packages/dataops-account` | 可发布 |
| `@sparkelf/dsh-ocr@0.1.0` | npmjs/npmmirror 404；源码 `private: true` | 发布前去掉 private，或走私有 registry/tarball |
| `dsh-sql-workbench@0.5.4-sparkelf.1` | 未发布；源码包名是 `@sparkelf/dsh-sql-workbench@0.5.4-sparkelf.1`（已发布） | 清单改用 `@sparkelf/dsh-sql-workbench@0.5.4-sparkelf.1`，或发布 unscoped fork |

解决方式三选一：发布到 npm、使用私有 registry、或由 CLI 支持本地 tarball 通道。CLI 已支持 registry 覆盖与回退。

## 10. 工作区镜像分两层

工作区镜像拆成两层：

1. **基础层：Python 依赖 + Linux 依赖**。几乎不变，单独一层，构建时有效缓存。
2. **DSH 层**。按第 5 节的三步构建：装 DSH base → 应用 DSH Plus patch → 安装 edition 清单中的插件。

日常开发循环：

```text
更新 tarball
  → 安装到容器
  → 在容器里验收（team edition 插件全部启用）
  → 满意后发布为 npm
  → 更新清单文件（dshPlus.editions）
```

镜像构建和日常迭代都走这条链；不手工复制模板、不手工改 profile。

## 11. 当前实现状态（2026-10-30）

- CLI 已支持 `install --edition personal|team`、`--profile`、从 npx 临时安装运行（distribution 回退到自身包）、base + edition 组合（edition 只含第三方/fork/自研插件）、registry 回退 + 单次尝试超时。
- 已发布：`@sparkelf/dsh-plus@0.2.2-alpha.2.2`（next）、`@sparkelf/dsh-dataops-account@0.2.0`、`@sparkelf/dsh-ocr@0.1.0`；republish 的官方包已补齐 `ui-schedule` / `ui-sidebar-right`。
- 待完成：真实 team edition 安装验收；8080 从手工恢复态切到 CLI 创建的新 profile；逐插件确认 enabled/mounted。
## 12. 工作区镜像的具体分层（2026-10-30 定稿）

- **base 层**：`python:3.12-slim-bookworm`，包含 314 个 Linux 包（`dataops/infra/docker-workspace/base-layer-linux.txt`）和 64 个 Python 包（`base-layer-python.txt`）。
- **DSH 层**：在 base 之上运行 `dsh-plus install --edition team`，完成“装 base → 应用 patch → 装 team 插件”三步。
- **明确排除**：Prefect worker 的 21 个依赖不属于 workspace 镜像；worker 单独处理。
- **构建入口**：
  - `docker build --network host --target workspace-base -f Dockerfile -t dataops-ai-workspace:base-py312 .`
  - `docker build -f Dockerfile.plus-cli --build-arg BASE_IMAGE=dataops-ai-workspace:base-py312 -t dataops-ai-workspace:plus-cli .`
- **验收**：镜像内 26 个 bundle、全部 team 包、allow 与 replay 补丁；替换 8080 容器后验收侧边栏权限菜单、知识库、工作流广场、技能广场、任务中心。

## 13. 已落地的运行态（2026-10-30）

- base：`dataops-ai-workspace:base-py312` = `python:3.12-slim-bookworm` + 314 Linux + 64 Python（含 git）。
- DSH 层：`dataops-ai-workspace:plus-cli-py312-v6`，用 `@sparkelf/dsh-plus@0.2.2-alpha.2.9` 跑 `dsh-plus install --edition team`。
- 运行时：`dataops-ai-workspace:plus-cli-py312-runtime-v6`，含 DataOps runtime、CLI profile、officecli 引擎（SHA256 `e8bfe04f...`）。
- 8080 companion：`dataops-preview-ai-preview-dsh-runtime`，配置与原容器一致；旧容器保留为 `...-prev`。
- 验证：`ready:true`，最近启动 skipping/disabled = 0，26 bundles，61 deps；`skill-plaza`/`model-sync`/`workspace-limits` 200，`managed-auth` 405（正常）；浏览器 `/plugins/??` 已加载 permission-presets、knowledge-base、dataops-managed、skill-center、task-bus 等客户端 bundle。

### 关键修复（都在 @sparkelf/dsh-plus 0.2.2-alpha.2.9）

- `autoInstallPeers: true`：不再手挑 peer。
- cordis 行别名：`dsh-better-sidebar` / `dsh-sql-workbench` → `npm:@sparkelf/...`。
- `@deepseek-ai/dsh-client-ui-slots` override 到 `0.2.2-alpha.2`，绕过插件里不匹配预发布版的 `>=0.2.1 <0.3.0` 范围。
- `@sparkelf/dsh-credential-manager@0.1.1` 修复 `dsh-client-ui-slots` peer 范围。

### 仍需完成

- 删除仓库里的 standalone 包与发行脚本，避免与 CLI/edition 并存。
- 用户硬刷新 8080 后逐项确认五项页面。

## 14. standalone 清理计划（代码未执行，运行时已不用）

1. `scripts/release/families.ts` 的 `PlusFamily.installedEntry` 改为 `@sparkelf/dsh-plus`（`lib/bin.js`）。
2. 从 `PlusFamily.patterns` 删除 `packages/standalone/*/package.json`。
3. 删除 `PlusFamily.installedEntries` 里的两个 standalone 条目。
4. `scripts/release/ship.ts` 删除“重新生成 standalone manifest”步骤。
5. `package.json` 删除 `verify:standalone-manifest`、`verify:standalone-variants`。
6. 删除 `packages/standalone/*` 与 `scripts/standalone/*`；保留/迁移 `verify:patch-manifest`、`verify:npm-patches`、`verify:mount-declarations` 需要的工具。
7. `pnpm install --lockfile-only`、`pnpm exec tsx scripts/verify-plus-governance.ts`、`release:ship --dry-run` 验证。

当前 8080 已在 CLI + team edition 上运行，standalone 只是仓库遗留发行路径。

## 15. 插件版本回退审计（2026-10-30）

- 22 个 team 包逐个对比上一发布版：只有 `@sparkelf/dsh-better-sidebar` 有 removed 文件（`CsvViewer.tsx`、`csv.ts`、`native/tab-menu.tsx`）；其余 `removed=0`。
- `@sparkelf/dsh-better-sidebar@0.29.0-sparkelf.4` 已补：`dsh.plugin.json`、开始页 grid CSS、`native/tab-menu.tsx`（复制/下载/关闭其他/全部；open-folder 因 0.29 无 `revealInExplorer` 暂不移植）。
- `@sparkelf/dsh-client-ui-diagram-viewer` 从 personal/team edition 移除，npm 已 deprecated；功能由 `diagram-preview` patch + `@sparkelf/dsh-client-ui-sidebar-documentpreview` override 承担。
- `dsh-video-preview` 是第三方（zemul），保留第三方层。
- plus `0.2.2-alpha.2.12`。

## 16. 8080 门户 → DSH 工作台链路修复（2026-10-30）

- 触发：门户 `/ai/dsh` 卡“正在恢复会话”/“无法启动 DSH AI 工作台”，点击跳回首页。
- 根因链：
  1. 8080 是 nginx 反向代理（`/api`、`/agent-ws`、`/ai-runtime-ws` → backend，`/` → frontend），原代理容器丢失；补回 `dataops-preview-proxy`（compose）。
  2. `DshWorkbenchPage.vue` 把 `targetOrigin` 取 `.origin`，丢掉 `/dsh`，iframe 指回门户首页；改为保留 path。
  3. 后端 `DATAOPS_PUBLIC_APP_ORIGIN` 不含 `http://127.0.0.1:8080`，且 `DATAOPS_MANAGED_DSH_PROXY_PATH` 为空；补 env（`/dsh`），重建 backend（保留 mounts + `host.docker.internal` extra host）。
  4. nginx 增加 `/_dataops/`、`/dsh/`、`/integrations/` → target listener 32300。
- 验证：`tests/dataops-preview/workbench-login.mjs` 两项 PASS（登录 + /dsh/ iframe 内出现“探索未至之境/新会话”），截图 `.cache/dataops-preview-shots/workbench-dsh.png`。
- 登录凭据本地笔记：`/root/projects/dataops/.dataops-preview/LOGIN-NOTES.md`（600）。
- 持久化：`/root/projects/dataops/.dataops-preview/docker-compose.yml`（proxy + frontend dist 挂载）、`backend-run.sh`、`nginx/default.conf`。
- 待办：KB 不可用状态美化（KB 0.1.22 + plus 0.2.2-alpha.2.17 已发布；镜像部署被 npmjs ETIMEDOUT / npmmirror 缺 `@sparkelf/dsh-ocr` 元数据阻塞，网络恢复后重建 v12 即可）。

## 17. 源码物化镜像分层（v14 设计，2026-10-31）

目标：恢复“本地拉 dsh base → dsh-plus patch → copy 产物”的旧流程，同时不让运行镜像背上 300 MB 源码。

### 分层

| 层 | 内容 | 说明 |
|---|---|---|
| `base-py312` | python:3.12-slim-bookworm + 314 个 Linux 包 + 64 个 Python 包（华为云镜像）+ **build-essential / cmake / cc、c++ 软链** | 构建工具链放在 base，源码 stage 不再装包，缓存稳定 |
| `dsh-source`（builder） | `git clone deepseek-harness@f3803c96…`、`npm i -g pnpm`、`pnpm install --frozen-lockfile`（npmmirror）、`pnpm build`（10 个 gate 全 PASS）、保留 `.git` | 只用于物化，不进最终镜像 |
| `plus-install` | `dsh-plus install --edition team`（npmmirror 优先）、`OFFICECLI_SKIP_BINARY_DOWNLOAD=1`、`COPY --from=dsh-source /src`、`dsh-plus apply --dsh-root`（profile 的 pnpm-workspace.yaml 先置 `autoInstallPeers: false`）、写 `.dsh-plus/patchset.lock.json` | 产出打补丁的 profile |
| `final`（FROM base-py312） | `COPY --from=plus-install /opt/dsh-home`、`COPY --from=dsh-source /src/packages` + `/src/apps` + 两个 manifest | 不带 `.git`、docs、snapshots、builder node_modules |

### 体积

- 完整源码 + `.git` = 300 MB（`.git` 107 MB + 工作树 193 MB）
- 去 `.git` = 193 MB
- 只留 `packages/` + `apps/` ≈ 120 MB
- 多阶段只 copy 构建产物 ≈ **100–150 MB**（最终采用）

### 镜像源策略

- Debian / pip：华为云镜像
- npm（源码 + plus 安装）：npmmirror 优先，缺包时 CLI 自动回退 npmjs
- GitHub clone / officecli 引擎：Clash Verge（192.168.64.1:7897，局域网已开）

### 已知问题（构建期）

- `dsh-plus apply` 的 profile 校验与 `dsh-plus install` 写出的值不一致（已对齐 team 版本、`autoInstallPeers`、range spec，继续跑仍可能暴露下一个字段）
- `native/system` 的 `spawnSync cc ENOENT` 在本轮（FROM base）仍复现，待查 PATH/缓存

### 网络策略落地（v14 构建）

- **npm 主源**：`https://registry.npmmirror.com`（`DSH_PLUS_INSTALL_REGISTRY` + `npm_config_registry`）
- **npm 回退**：npmmirror 缺包（主要是 `@sparkelf/*` 新版本、`@deepseek-ai/libreoffice-kit-*`、`sherpa-onnx-*` 等跨平台可选包）时走 npmjs
- **npmjs 走 Clash**：plus-install 阶段显式 `HTTP_PROXY/HTTPS_PROXY=http://192.168.64.1:7897`，并在 profile `.npmrc` 写入 `proxy/https-proxy`，避免 pnpm 直连超时重试
- **重试**：`fetch-retries` 降为 2、`fetch-timeout` 30s，减少 1 分钟级等待
- **GitHub**（source clone / officecli 引擎）：Clash 代理；officecli 在 plus-install 用 `OFFICECLI_SKIP_BINARY_DOWNLOAD=1` 跳过下载
- **Debian / pip**：华为云镜像

## 18. 构建流程定稿（v18，2026-10-31）

### 单阶段，不再多阶段

运行时必须带 `/opt/dsh-source/node_modules`：`dsh-plus apply` 会把打补丁的官方 workspace 链进 profile，workspace 的 `import '@deepseek-ai/cordis'` 等要在源码树自己的 node_modules 解析。多阶段只省 `.git/docs/snapshots`（约 100–150 MB），node_modules 仍要整份 copy——复杂度没有收益，改为**单阶段**：

```text
FROM base-py312
  apt: git build-essential python3 cmake + cc/c++ 软链
  npm i -g pnpm@11.28.5          （npmmirror，带 npm cache mount）
  git clone deepseek-harness@f3803c96… → /opt/dsh-source
  pnpm install --frozen-lockfile （npmmirror，带 pnpm store cache mount）
  npm i -g plus .25 + CLI 安装超时 5→20 分钟补丁
  dsh-plus install --edition team
  bash apply-plus.sh             （平台过滤 + stub + apply；apply 内再 install + build:official）
  模板 + marker + better-sidebar/sql-workbench 软链
```

### 关键参数

| 项 | 值 | 依据 |
|---|---|---|
| pnpm 版本 | 11.28.5（全局唯一） | 对齐 DSH monorepo `packageManager`；不再用 corepack |
| npm 源 | npmmirror 主源，npmjs+Clash 回退 | 实测 3.77 MB/s vs 1.92（直连）/2.41（代理） |
| fetchTimeout | 300000 ms | `GET … error (23)` 是 pnpm 60s 单请求超时（dsh-market pnpm-compat 证据），不是 ECONNRESET |
| fetchRetries / 重试间隔 | 3 / 5s–30s | 同上 |
| CLI install 超时 | 5→20 分钟 | `spawnSync pnpm ETIMEDOUT` 根因；plus 发布包 lib 是旧构建 |
| cache mount | `/root/.local/share/pnpm/store`（sharing=shared）+ `/root/.npm` | 规避 Dockerfile 注释里记录的 `/pnpm/store` futex/epoll 死锁 |
| 预构建 | 不跑 `pnpm build` | `dsh-plus apply` 的 `build:official` 会在打补丁后构建一次；预构建是未打补丁的树，纯浪费 |

### 验证门禁

- `pnpm build` / `build:official`：10 gates 全 PASS（native addon / Host Typert / host compiler / Host bundle / Desktop bundle / client compiler / Client bundle / Web build / host+client aggregate checks）
- `dsh-plus apply`：`applied 23 patches`，写 `.dsh-plus/patchset.lock.json`
- 最终层必须保留 `/opt/dsh-source/node_modules`（v14 缺它导致 `Cannot find package '@deepseek-ai/cordis'` 启动失败）

## 19. 权威版本核对与 KB 403 取证（2026-10-31）

### 权威基线

| 项 | 值 |
|---|---|
| DSH base 版本 | `0.2.2-alpha.2`，提交 `f3803c96`，**2026-10-28 02:17:58 +0800**（release(dsh): 0.2.2-alpha.2 #7437） |
| dataops backend 对齐日 | 2026-10-28（`4c520ddb` 2026-10-28 22:16 / `cee4d51f` / `2dcb0ca3` / `b8dc6628` 2026-10-29） |
| 旧可用工作区镜像 | `dataops-ai-workspace:20261030-022-final`（2026-10-30 08:41，profile marker `0.2.1-rc.2.4+faf2fd…`）；备份 `20261029-prev` 同版本 |

### “缺 KB 服务 API”判断被推翻

在权威 backend（`4c520ddb`）上 `git grep "knowledge-base/api"` **无结果**，也没有 knowledge controller。旧版同样没有该 API，因此 KB 的 list/search/pins/favorites 一直是**插件本地处理**（`webServer.register('/knowledge-base/api')`），不是后端服务。之前“缺 API”的方向错误。

### KB 403 的真实路径

KB host 路由在团队部署下先做权限门禁：

```ts
const requiredPermission = permissionForKbRoute(method)
if (requiredPermission !== undefined && isTeamDeployment(config)) {
  const permissionContext = await Promise.race([managementHost.context()...])
  // 取不到上下文 → 视为未授权（403）
}
```

403 = **插件自己的权限门禁**拿不到 `managementHost.context()`（DataOps 身份/权限上下文），不是 API 缺失、也不是目标转发拦截。

### 已尝试（均未消除 403/502）

- `DATAOPS_PUBLIC_APP_ORIGIN` 增加 `http://127.0.0.1:8080`
- overlay `web-runtime` 行补 `browserAuthentication: disabled`
- `trustedHosts` 改为多值 origin 解析
- `DATAOPS_AI_WORKSPACE_BACKEND_BASE_URL` 由门户 8080 改为 `http://dataops-preview-backend-1:3101`

### 下一步（Next）

1. 直接检查工作区里 `DATAOPS_ACCESS_TOKEN` 是否存在、`/integrations/dataops/...` context 是否可达（容器内 curl + DSH 日志）；
2. 对照 `20261030-022-final` 的旧 profile（KB 版本/配置、schedule 行、plaza、overlay）逐项恢复；
3. 任务中心、技能广场、KB 侧边栏菜单按同一权威镜像恢复。

## 20. 权威 0.2.1 基线镜像（2026-10-31）

纯 0.2.1 DSH package 的可用镜像（此前对比的 20261029-prev / 20261030-022-final 实为 0.2.2 package + 0.2.1 profile，非纯 0.2.1）：

| 镜像 | 大小 | 创建时间 | DSH package | KB | bundles |
|---|---|---|---|---|---|
| `dataops-ai-workspace:local` | 5.75 GB | 2026-10-29 10:20 | **0.2.1-rc.2** | 0.1.20-sparkelf.ui8 | 29 |
| `dataops-ai-workspace:v8-container-kb013-fixed-20261026` | 5.32 GB | 2026-10-26 04:40 | 0.2.1-rc.2 | 0.1.13 | 28 |

`local` 的 profile bundles（29）含：dsh-base、agent-team-profile、web-app、auto-review、mineru、officecli、dshmarket、better-locale、office-viewer-fonts、video-preview、genui、plugin-supervisor、dsh-plus、sql-workbench、ssh-manager、api-client、right-bg-anim、diagram-viewer、**dataops-managed、query-result-analysis、better-sidebar、credential-manager、knowledge-base、group-chat、ocr、dataops-admin、dataops-account、kb-citation、task-bus**。

**结论**：`local` 是 0.2.1 线的权威工作版本。目标：先在 companion 上部署 `local` 验证旧行为（KB 搜索、任务中心、技能广场、allow、侧边栏菜单），再把权威源的这些功能**全部恢复到新 DSH base（0.2.2-alpha.2）**的 v18/v15 镜像。

## 21. 开发约定：前后端源码 `npm run dev`（2026-10-31）

- DataOps 前端（`frontend/`）与后端（`backend/`）的开发、排查、联调**一律用源码 dev server**：`npm run dev`，不要为验证改动反复重建/重启容器。
- 容器镜像只在部署/验收阶段使用；容器内的 `docker cp`/重建只用于部署验证，不作为开发迭代手段。
- 前端 dev 默认 3000、后端 3101；联调通过 dev server 代理或 `DATAOPS_PUBLIC_APP_ORIGIN` 指向本地端口。
- 该约定已写入 `dataops/AGENTS.md`「本地开发」一节。

## 22. 8080/8081 清理与 KB 恢复（2026-10-31 收尾）

- 门户实际工作区是 `dataops-ai-admin`（不是 preview）；其 companion 的旧 env 带 8081，是 KB 403 的根源。
- 正确约定：`DATAOPS_AI_WORKSPACE_BACKEND_BASE_URL=http://host.docker.internal:8080`（工作区经宿主门户 `/api` 代理到 backend），`DATAOPS_PUBLIC_APP_ORIGIN=http://127.0.0.1:8080`。
- v18 镜像模板缺 team edition 的 9 个 DataOps bundle，已补入 `dsh.profile.bundles`（dataops-managed/query-result-analysis/credential-manager/knowledge-base/group-chat/ocr/dataops-account/kb-citation/task-bus）。
- 清理：admin-old、preview 重复 companion（v18b/local/prev12）、backend prev2/3/4。
- 验收：knowledge 搜索恢复（搜索失败=false、21 文件、0 失败请求）；菜单恢复；任务中心仍「无法加载任务」（task-center API 存在且 401 无凭证，面板请求未捕获，待查 task-bus 文档/服务端路由）。

### 任务中心（task-bus）排查续

- host 路由已通：iframe 内直接 fetch `/dsh-task-bus/api/overview` → 200，返回 1 条审批任务（approval:5，万相 AI 中台审批联调 20261027）；`/count` → 200。
- 面板 UI 仍「无法加载任务」；iframe console 只有一个 401（session 握手）和一个 mobile-bridge CSS MIME 噪音。
- 判断：面板客户端在 auth 就绪前挂载 fetch 或在 401 时未重试，属于 **task-bus 客户端**（`packages/task-bus/src/client/index.tsx`）问题，非配置/镜像。
- 下一步：给面板 fetch 加 401 重试/等待 auth 就绪，重新发布 task-bus。

### 任务中心面板组件身份（续）

- 面板 DOM 链：`P.vDvVNG_emptyTitle < DIV.vDvVNG_empty < ...`（CSS Modules 哈希 vDvVNG_）。
- 该哈希在 task-bus/KB/dataops-admin 已安装客户端、portal 前端 dist、运行中 frontend 容器 html 里都搜不到 → 面板来自来源不明的旧/第三方 bundle（疑似历史 .pkg-backup 或旧构建残留），不是当前 task-bus 插件。
- task-bus 数据层已验证 200（1 条审批任务）。
- 下一步：按 vDvVNG 哈希在全盘/镜像层定位来源，或清理 .dataops-extra-plugins 残留后重装 task-bus 客户端，再看面板。

### 「自动化任务」面板真实身份（2026-10-31）

- 面板文案「新建/已开启/已结束/全部/无法加载任务」来自 **KB 客户端的工作流广场（workflow plaza）**，不是 task-bus 插件；`已开启` 命中 portal dist 的 authService chunk、`自动化任务` 命中 KB client locales.ts。
- KB 客户端的 KB 请求用 `kbApiPath()`（root-relative `/knowledge-base/api`），在 DSH iframe（`/dsh/`）下仍能命中 nginx 的 `/knowledge-base/` 路由（已验证树/搜索可用）。
- 但工作流广场的请求路径不同（疑似 `/api/...` root-relative），在 iframe 下解析成 `/dsh/api/...` → 404 → 「无法加载任务」。
- 下一步：在 `packages/knowledge-base/src/client` 找到工作流广场的 fetch 路径（workflow/task-center），改为与 KB 相同的宿主路由或 `DATAOPS_PUBLIC_APP_ORIGIN` 绝对地址。

### 任务中心连接器 404 修复（2026-10-31）

- 现象：任务中心「万相 AI 中台连接器」显示「连接器状态读取失败（404）」。
- 根因：运行中的 task-bus 只有**旧服务端**（`lib/index.js` 不识别 `/connector` 路由，返回 `{"error":"Unknown Task Bus route"}`）；之前只部署了客户端。
- 修复：重新构建 task-bus 并把 **服务端 lib/index.js + 客户端 client.js** 一起部署到 admin profile，重启 DSH。
- 验证：`/dsh-task-bus/api/connector` → 200 `{enabled:false,capabilities:{approval.push:true}}`；面板「读取失败/连接异常」消失。

### 任务中心「无法加载任务」根因修复（2026-10-31）

- 根因：`/workspace/.dataops/dsh/storages/schedule.json` 里有一条旧 0.2.1 schema 的任务记录 `schedule-47750882-…`，新 0.2.2 的 schedule 域加载时 `does not match its schema` 报错，整个 schedule 域失效 → 面板「无法加载任务」。
- 修复：备份 schedule.json 后删除该陈旧记录（tasks 2 → 1），重启 DSH。
- 验证：面板「无法加载任务」消失，已开启/权限正常；连接器路由 200。

### 权限「完全权限」UI 验证（2026-10-31）

- 在 /ai/dsh 的输入框「工作区内修改」下拉中看到权限预设：
  **仅可查看 / 工作区内修改 / 完全权限 / 自动审查**
- 即 user-approval 的 allow/完全权限 在 UI 上已呈现（与 profile 里打上的 approval-allow-policy 一致），无 service-unavailable。
- 技能中心可打开、权限中心（角色矩阵）可打开，均无失败请求。

## 23. 周四需求（1–5）全部部署验收（2026-10-31 深夜）

按周四晚到周五凌晨的需求逐项从工作区源码构建并部署到 admin profile（v18/v0.2.2-alpha.2.25）：

| # | 需求 | 实现 | 验收 |
|---|---|---|---|
| 1 | 技能中心 tab（内置/个人/部门/技能广场/连接器） | skill-center 2.2-alpha.2.3 构建部署 | ✅ 五个 tab 全部渲染（内置7/个人7/连接器2） |
| 2 | 任务面板移除连接器 + task-bus 重构 | task-bus lib 重建部署 | ✅ 面板无连接器、任务列表正常（每日八点问候） |
| 3 | 权限与工具披露配合 | dataops-managed auth-state/tools 构建部署 | ✅ 插件激活无错误 |
| 4 | dataops-managed ↔ credential-manager | 两端 lib 重建部署 | ✅ 激活无错误 |
| 5 | KB 面板/回收站/管理工具 UI | knowledge-base lib 重建部署 | ✅ KB 树 21 文件、搜索正常 |

最终组合验收：KB 搜索失败=false、任务面板连接器=false/无法加载=false、技能中心 内置/技能广场/连接器=true、FAILS 空。

遗留（非本次需求）：
- better-sidebar 菜单项高亮样式（open-issues 已记）；
- skill-center 的 npm publish 因本机未登录未完成，当前用本地构建分发；补 token 后再发。

## 24. 菜单样式修复与收尾（2026-10-31 晚）

- 根因：better-sidebar 0.29.0-sparkelf.8 的 `sidebar.module.css` 丢了 `.nativeTabMenuItem` / `.nativeTabMenuSeparator`，`tab-menu.tsx` 的 MenuRow 类名为 undefined → 原生 `<button>` 灰底。
- 修复：补回样式类（transparent + hover），发布 `0.29.0-sparkelf.9` 并部署验证菜单恢复正常（截图确认）。
- 追加：`0.29.0-sparkelf.10` 补回「打开所在位置」（revealInFileManager，接 shell 的 openInApp.reveal），已发布并部署到 admin 工作区。
- plus：`0.2.2-alpha.2.26` 已发布，better-sidebar 钉 `0.29.0-sparkelf.10`。
- hooks：credential-manager 补 repository/homepage（0.1.3）后 third-party notices 通过；plus 清单提交已不带 `--no-verify` 成功。

### 补充（2026-10-31 晚）

- better-sidebar `0.29.0-sparkelf.11`：打开所在位置 = 应用内 reveal（选中 + 展开父级 + 滚动到行），已发布并部署。
- plus `0.2.2-alpha.2.27` 已发布（钉 better-sidebar .11），提交通过 hook。

## 25. 「打开所在位置」验证闭环（2026-11-01）

**CDP 实测证据**（Chrome 窗口标题内 JSON + 截图）：

```json
{"selected":1,"rowText":"test-menu.md 10-31@文件",
 "scrollTop":730,"scrollHeight":4238,"clientHeight":144,
 "rowTop":653,"bodyTop":595}
```

- selected=1：目标行进入选中态
- scrollTop=730 > 0：文件树滚动生效
- rowTop=653 落在容器 [595, 739]（bodyTop 595 + clientHeight 144）内：行已滚动到可视区
- 结论：better-sidebar 0.29.0-sparkelf.14 的「打开所在位置」= 选中 + 展开父级 + 滚动到行，全部工作

**验证方法（可复用）**：Playwright 安装的 Chrome for Testing（`%LOCALAPPDATA%\ms-playwright\chromium-1248\chrome-win64\chrome.exe`）以 `--remote-debugging-port` 启动 → PowerShell .NET WebSocket 跑 CDP `Runtime.evaluate` → 在 /ai/dsh iframe 内操作文件面板、页签右键菜单并读取 `data-dsh-selected`/`scrollTop`。

**过程中的坑**：系统 Chrome 安装损坏（SxS 错误，`Application\chrome.exe` 不可用），只能靠 Playwright 的 Chrome for Testing；驱动的 browser_prepare 端点归属校验在本机失败，改用 PowerShell WebSocket 直连 CDP。

## 26. 「打开所在位置」真选中态验证通过（2026-11-01）

**判据（用户定义）**：目标行蓝色竖条 + 底部「已选择 1 项 / 复制路径 / 删除所选 / 取消选择」栏。

**Playwright 实测**（容器内 Playwright + /usr/bin/google-chrome，走页签菜单路径）：
```json
{"footer":"已选择 1 项","selRow":"test-menu.md 10-31@文",
 "cls":"s56VVa_explorerRow s56VVa_explorerRowSelected s56VVa_explorerRowReveal"}
```
截图：`/root/projects/dsh-ui-shots/tab-reveal.png`（蓝条 + 底部栏可见）。

**修复链**：.12 revealed→selected 同步 + .15（revealPath 改为 setSelected+滚动，供行菜单使用）。页签菜单路径 = service.revealInExplorer + store reduce → FileTree 的 selected 生效。

**遗留**：行菜单「在文件管理器中显示」原本是系统文件管理器 reveal，.15 把它改成应用内选中——需确认产品语义（建议恢复系统 reveal 或改文案）。

## 27. 「打开所在位置」右侧面板真选中验证通过（2026-11-01）

- .16：新增 revealBus（src/client/reveal-bus.ts）；service.revealInExplorer 在 store reduce 之外 emit，FileTree 订阅后 setSelected+滚动 —— 让右侧 native Files 面板（独立树实例）也能收到 reveal。
- .17：首次点击时 Files 页面刚 mint、树晚于 reveal 挂载，故 350ms 后重放一次 reveal（等价于用户“第二次点才行”的手感）。
- Playwright 实测（第一次点击）：两个面板都出现选中；右侧 explorer（x=925）内 selected 行为 test-menu.md（x=933），底部「已选择 1 项」栏可见。截图 `/root/projects/dsh-ui-shots/where-selected.png`。
