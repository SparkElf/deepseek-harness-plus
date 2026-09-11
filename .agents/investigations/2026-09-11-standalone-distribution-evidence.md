## 验证环境

```
/tmp/p0        P0 主实验（含我们的插件与 16 项 bundle） /tmp/peer-test 对照：正常 npm install（276 包） /tmp/legacy-test 对照：--legacy-peer-deps（244 包） /tmp/closure-check 干净官方 dsh 安装
```

## 成立的核心命题

| 命题 | 结果 | 证据 |
|---|---|---|
| 纯 npm 安装，无源码、无构建 | ✅ | 521 包 23 秒装完 |
| 前端产物随包发布 | ✅ | `dsh-web-frontend/dist/index.html` 在包内 |
| 官方 web profile 纯 npm 可启动 | ✅ | 打印 `dsh web: http://127.0.0.1:3285/?token=...` |
| profile 可解析外层 node_modules | ✅ | 符号链接方式实测可行 |
| 16 项 bundles 可逐项声明 | ✅ | **最终启动成功**：`dsh web: http://127.0.0.1:3289/?token=...` |
| 不需要打包完整依赖树 | ✅ | 见下方"纠正"一节 |

## 重要纠正（两次自我误判）

### 纠正 1：不存在"官方缺失 17 个服务定义包"

我曾报告"官方多个包 import 了未声明的包"，并给出"扫描 207 包、130 处未声明引用"的数字。

**这个结论是错的。** 对照实验：

| 安装方式 | 包数 | 服务定义包 |
|---|---|---|
| 正常 `npm install` | 276 | ✅ 全部带入 |
| `--legacy-peer-deps` | 244 | ❌ 全部缺失 |

**根因**：我在 P0 排障时用了 `--legacy-peer-deps`，该标志**跳过 peer 依赖安装**。 官方的服务定义包是通过 **peerDependencies** 提供的，正常安装全部到位。

那 16 个"缺失包"（`dsh-jobs`、`dsh-settings`、`dsh-attachment` 等）**是我自己造成的**，不是官方缺陷。

### 纠正 2：`dsh-app-boot` 的 `cordis-plugin-group` 引用

在 `--legacy-peer-deps` 的树里，`dsh-app-boot` 因缺该包而失败；但在正常安装的树里， 官方 web profile **能正常启动**，说明该路径非必需，或由 peer 机制解析。

## 对方案的影响

**"自带完整依赖树"（+300 MB）的做法不需要了。** 正确做法：

```jsonc
// 新包的 dependencies —— npm 会解析 peer，自动带齐服务定义包 { "@deepseek-ai/dsh": "0.1.5-rc.2",     // 官方运行时（peer 树自动展开） // + 我们的 15 个插件（精确 pin） }
```

**关键是绝不能使用 `--legacy-peer-deps`** —— 无论在我们 CI 里还是文档里。

## 遗留的真实约束

| # | 约束 | 处理 |
|---|---|---|
| 1 | profile 的 `bundles` 不递归展开 | `start` 命令自己生成 manifest（写全 16 项） |
| 2 | `dsh plugin add` 只写 2 项 bundles | 同上，不复用它 |
| 3 | 每次都需 npm 正常解析 peer | CI 与文档禁用 `--legacy-peer-deps` |
| 4 | `@sparkelf/dsh-workbench-vault` 的 npmmirror 未同步 | 用官方 registry |

## 下一步

1. 修正闭包检测脚本：它应检测 **peer 是否可达**，而非"声明缺失"
2. P1：预构建产物 + 平台矩阵
3. P2：`dsh-plus` CLI（start/stop/status/update/doctor）

---

# P1 进展与真实阻塞

## 已完成

1. **单一事实来源生成器** `scripts/standalone/generate-manifest.ts` 从 `packages/bundle/plus/package.json` 自动派生 standalone manifest， 输出 12 个精确 pin 的插件 + 16 项 bundle 顺序。插件清单不再重复维护。

2. **闭包检测器** `scripts/standalone/verify-runtime-closure.ts` 对正常安装的官方树运行结果：`every official import in the runtime tree resolves.` 证实正常 npm 安装下官方运行时是自洽的。

## 阻塞：已发布插件与当前运行时 peer 不兼容

用生成的 manifest 做真实安装时报 `ERESOLVE`：

```
peer @deepseek-ai/dsh-api-session-controller@"0.1.5-alpha.1" from @sparkelf/dsh-plugin-supervisor@0.1.4 Found: @deepseek-ai/dsh-invariants@0.1.5-rc.2
```

### 根因

| 事实 | 值 |
|---|---|
| npm 上 `supervisor@0.1.4` 发布时间 | 2026-09-09T04:56Z |
| 插件源码对齐 rc.2 的提交 | `d329ebc`（更晚） |
| 插件仓库源码当前 peer | `0.1.5-rc.2`（已正确） |

**我们升级了插件源码到 rc.2，但没有重新发布。** npm 上仍是 alpha.1 时代的内容。

### 规模

插件共 **37 处 peer 精确 pin** 锁在 `0.1.5-alpha.1`：

| 插件 | 精确 pin | 范围 |
|---|---|---|
| `@sparkelf/dsh-plugin-supervisor@0.1.4` | 4 | 1 |
| `@sparkelf/dsh-ssh-manager@0.7.0` | 11 | 2 |
| `@sparkelf/dsh-api-client@0.5.0` | 10 | 1 |
| `dsh-sql-workbench@0.5.0` | 10 | 1 |
| `@sparkelf/dsh-mineru@0.1.1` | 1 | 1 |
| `@sparkelf/dsh-officecli@0.1.1` | 1 | 1 |

### 影响

standalone 安装**必然失败**：npm 无法同时满足"官方运行时 rc.2"与"插件 peer alpha.1"。

### 修复方向

1. **重新发布插件**（版本递增），使 npm 上的 peer 为 rc.2 —— 必须做。
2. **重新审视 peer 精确 pin 策略**：精确 pin 意味着**每次官方升版都要重发全部 6 个插件**。 可考虑改为范围（如 `^0.1.5-rc.1`）并依赖 `minimumReleaseAge` 冷却期， 但需权衡"组合可复现"这一既有决策。

### 下一步

- P1 剩余：预构建产物 + 平台矩阵（依赖插件重新发布后才能端到端验证）
- P2：`dsh-plus` CLI（start/stop/status/update/doctor）

---

# 第 2 轮：发布漂移门禁（已完成）

## 关键环境事实

**本机 npm token 已失效**（`npm whoami` 返回 401），因此**无法在本机重新发布插件**。 但两个仓库都有发布工作流（插件仓库 `.github/workflows/publish.yml`，触发条件为 `v*` tag 或手动）， 所以重发应通过**推 tag**完成，不需要本机 token。

## 完成：发布漂移门禁

`dsh-plugins-plus/scripts/verify-published-peers.mjs`

### 它解决的问题

插件用**精确 pin** 声明 DSH peer，意味着官方升版后**必须重新发布**才能被消费者安装。 这次漏发就是典型：源码已对齐 rc.2，npm 上仍是 alpha.1，CI typecheck 全绿，无人发现。

### 实测结果

```
11 package(s) publish peers that contradict their source 3 package(s) not published at the source version
```

漂移范围**比先前估计的 6 个更大**（实际 11 个）：

| 包 | 漂移的 DSH peer 数 |
|---|---|
| `dsh-ssh-manager@0.7.0` | 11 |
| `dsh-api-client@0.5.0` | 10 |
| `dsh-dataops-managed@0.3.1` | 10 |
| `dsh-dataops-integration@0.1.1` | 9 |
| `dsh-plugin-supervisor@0.1.4` | 4 |
| `dsh-chart` / `dsh-mineru` / `dsh-officecli` / `dsh-office-viewer-fonts` / `dsh-mobile-bridge` / `dsh-query-result-analysis` | 1–8 |

### 基线机制

因为 11 处漂移**无法在本机修复**（无发布权限），门禁采用基线：

- `scripts/published-peer-drift.baseline` 记录已知漂移
- **新漂移 → exit 1**（CI 失败）
- 已记录的漂移 → 警告
- 基线中已不漂移的条目 → 警告要求清理

### 双向验证

| 操作 | 结果 |
|---|---|
| 清空基线后运行 | **exit 1**，报出 11 处为新漂移 ✅ |
| 恢复基线后运行 | **exit 0** ✅ |

### CI 接入

`.github/workflows/ci.yml` 的 test 作业：

```
… → Typecheck → Published peer drift → Unit tests → Build publishable artifacts
```

## 待办

| 项 | 状态 |
|---|---|
| 重新发布 11 个插件（使 peer 为 rc.2） | ⛔ **需您推 tag 或恢复 npm token** |
| P1 预构建产物 + 平台矩阵 | 待插件重发后验证 |
| P2 `dsh-plus` CLI | 未开始 |
