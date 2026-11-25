# @sparkelf/dsh-dataops-admin

用万相数据中台后台 HTTP 接口做**账号与权限管理**。**形态是技能（`SKILL.md` + 一次性脚本），不是 DSH 工具。**

## 两个名字，别当成两个东西

| 场合 | 名字 |
| --- | --- |
| 包名 / 目录 / 注册表标识 / 文件名 | `dataops-admin`、`@sparkelf/dsh-dataops-admin` |
| **技能中心里用户看到的名字** | **万相数据AI中台管理** |

- `dataops-admin` 是**内部标识**：目录名、`package.json` 的 `name`、`SKILL.md` frontmatter 的
  `name:`、注册表里的 provider 名、脚本文件名。**这些都不能改成中文**——目录名要匹配
  `^[a-z0-9]+(?:-[a-z0-9]+)*$`，不匹配的目录技能中心会**静默跳过**。
- `万相数据AI中台管理` 是**展示名**，写在 `i18n/zh.json` 的 `title` 里。技能中心读的是
  这个文件（`readSkillTranslation()` 读 `SKILL.md` 同级的 `i18n/zh.json`），**不是** frontmatter。

**所以改名只改 `i18n/zh.json`，不要动目录名和 `name:`。** 改了目录名会让技能从列表里消失，
而且不报错。

## 为什么是技能而不是工具

一次管理操作是「登录 → 调一个接口 → 退出」的固定序列。做成 DSH 工具意味着：

- token 必须在多次调用之间存活，工具得自己管会话状态；
- token 会进入模型上下文，等于把凭据暴露给对话记录。

而一次性脚本可以在一个进程里完成登录、动作、退出，**凭据只在那个进程的内存里存在**，结束即消失。技能文档负责告诉 AI 何时调用、怎么调用、边界在哪。

另一个理由：用户需求是"把账号密码交给 AI"。工具的参数会被完整记录进会话日志，脚本则可以从**环境变量**读取——密码不必出现在任何被记录的字段里。

## 内容

```
SKILL.md                     给 AI 的操作说明（触发时机、动作、权限边界、失败处理）
scripts/dataops-admin.mjs    CLI 入口：登录 + 一个动作
scripts/lib/actions.mjs      白名单动作 → 具体 HTTP 请求（纯函数）
scripts/lib/auth.mjs         登录结果判定、MFA 分支、超管门禁（纯函数）
scripts/lib/redact.mjs       密码/令牌脱敏（纯函数）
tests/                       56 条单测，全部不打网络
```

## 使用

```bash
DATAOPS_ADMIN_USER='admin' \
DATAOPS_ADMIN_PASSWORD="$DATAOPS_ADMIN_PASSWORD" \
  node scripts/dataops-admin.mjs list-users --base-url http://127.0.0.1:3101
```

先跑 `--dry-run` 看请求；写操作加 `--yes` 才执行。详见 `SKILL.md`。

## 后端接口出处（都抄自 controller，未猜）

| 动作 | 请求 | 权限 |
| --- | --- | --- |
| 登录 | `POST /api/auth/login` `{account,password}` → `{accessToken,user}` | 匿名 |
| 列用户 | `GET /api/system/users` | `system:user:read` |
| 列角色 | `GET /api/system/roles` | `system:role:read` |
| 建账号 | `POST /api/system/users` | `system:user:create` **+** `system:role:update` |
| 改角色 | `PATCH /api/system/users/:id` `{roleCodes}` | `system:user:update` **+** `system:role:update` |
| 重置密码 | `POST /api/system/users/:id/password/reset` `{updatedAt,password}` | `system:user:update` |

来源：`src/main.ts:51`（`setGlobalPrefix('api')`）、`src/auth/auth.controller.ts:116`、
`src/system/users/users.controller.ts:24-97`、`src/system/roles/roles.controller.ts:19-40`。

## 安装 / 部署

与 `@sparkelf/dsh-knowledge-base` 走同一条 tarball → profile 的路：

```bash
# 1) 打包
cd packages/dataops-admin
npm pack --pack-destination /tmp/plugins
# → /tmp/plugins/sparkelf-dsh-dataops-admin-0.1.0.tgz

# 2) 装进运行中的 profile（容器内执行）
install-local-plugins.sh /workspace/.dataops/dsh/profiles/dataops-web \
  /tmp/plugins/sparkelf-dsh-dataops-admin-0.1.0.tgz

# 3) 重启
dataops-dsh-service stop; sleep 3; dataops-dsh-service start
```

### ⚠️ 裸装不够：本包没有 Host 半边，技能不会被自动发现

**这是本包与 knowledge-base / genui 的关键差别，部署前必须读。**

DSH 的技能发现走 `skill-filesystem` 的**扫描根**（`packages/skill/skill-filesystem/src/index.ts`
的 `roots()`）：只扫项目根的 `.dsh/skills`、`.agents/skills`、`$DSH_HOME/skills`、
`$AGENTS_HOME/skills`，以及 `$DSH_BUNDLED_SKILL_DIR`。**`node_modules` 不在扫描根里**——
把包 `npm pack` 装进 profile，`SKILL.md` 不会自动出现在技能目录中。

knowledge-base 和 genui 之所以能用，是因为它们各自有 **Host 半边代码显式注册 provider**：

```ts
// knowledge-base/src/index.ts:4538
hostWithInject.inject(['skills'], (scoped) => {
  scoped.skills.registerProvider(() => knowledgeBaseSkillProvider() as never)
})
```

本包目前**只有 `SKILL.md` + 脚本，没有 Host 半边**，所以它不会被自动发现。
`ls` 能看到文件，但 AI 的技能够不着它。

**两条落地路径，二选一（我还未实施，需要确认后再动）：**

1. **补一个最小 Host 半边**（与 knowledge-base 同构）：`src/index.ts` 用
   `registerProvider` 把 `SKILL.md` 注册进技能注册表，`cordis.patch.yml` 挂进
   `profile.bundles`。好处是随包走、重建不丢；代价是要加 tsdown 构建。
2. **不进包，直接落到扫描根**：把 `SKILL.md` 放到 `$DSH_HOME/skills/dataops-admin/`
   （并让 `scripts/` 同目录可达）。
   **本部署里 `$DSH_HOME` 的实际值是 `/workspace/.dataops/dsh`**——它由
   `dataops-dsh-service` 的 `resolve_dsh_home()` 决定：没设 `DATAOPS_DSH_HOME` 时取
   `<workspace>/.dataops/dsh`，所以扫描根是 `/workspace/.dataops/dsh/skills/`。
   好处是零代码；代价是**重建镜像会丢**（同下文），且需要写进模板才能持久。

**在实施其中一条之前，本包"装上了"不等于"AI 能用"。** 下面的自检只证明文件在，
不证明技能已注册——注册状态下应该能在技能目录里看到 `dataops-admin`。

### ⚠️ 重建镜像会丢，必须同时进模板

`dataops-dsh-service` 的 `prepare_profile()` 在模板 `version+digest` 与 profile 不一致时，
会**删掉整个 profile 目录重建**，只保留 `cordis.patch.yml`。所以只有"装进 profile"是不够的：

- 把 tarball 放进 **`/opt/dataops-dsh-profile-template/.dataops-extra-plugins/`** 并在模板
  `package.json` 里声明 `file:` 依赖；或
- 通过镜像构建的 `--build-context extra-plugins=<dir>` 上下文，让
  `finalize-extra-plugins.mjs` 把它变成随树走的 `file:` 依赖。

**这是 knowledge-base 踩过的坑**：只 `docker cp` 进 profile，重建镜像后就消失了。

### ⚠️ 这个包装"成功"了也可能没生效，必须自己确认

本包是 **skill-only**（没有 client bundle、没有 `dsh.bundle`/`dsh.client` 声明，也不在
`profile.bundles` 里），因此 `/root/projects/dataops/infra/docker-workspace/align-substituted-profile.mjs`
的 `REQUIRED_BUNDLES` **不会校验它**——那个清单只校验有 bundle 行的包。

**代价是：它没装上、或装错了目录，不会有任何报错，也不会有人在启动日志里发现。**
knowledge-base 少了 client bundle 页面会白/会报错，这个包少了就只是"AI 突然不会用"。

装完照这个顺序确认（**三层，缺一层都不算装好**）：

```bash
PROFILE=/workspace/.dataops/dsh/profiles/dataops-web
PKG="$PROFILE/node_modules/@sparkelf/dsh-dataops-admin"

# 第 1 层：文件在不在
ls -l "$PKG/SKILL.md" "$PKG/scripts/dataops-admin.mjs"

# 第 2 层：脚本能不能跑（这一步不登录，只打印用法）
node "$PKG/scripts/dataops-admin.mjs" --help

# 第 3 层：技能有没有真的进目录（这才是 AI 能不能用）
#   → 若走了上面的「路径 1：最小 Host 半边」，这里能看到 dataops-admin
#   → 若只做了 npm pack + install，这里看不到，说明技能未注册
#   本部署的 DSH_HOME 是 /workspace/.dataops/dsh（见上节），扫描根就在它下面的 skills/
ls -l "${DATAOPS_DSH_HOME:-/workspace/.dataops/dsh}/skills/dataops-admin/SKILL.md" 2>/dev/null
```

**第 3 层是重点。** 前两层过了只证明"文件拷贝成功"，不证明"AI 够得着"。

模板那份同样要确认（重建镜像时用的是它，不是运行中的 profile）：

```bash
ls -l /opt/dataops-dsh-profile-template/node_modules/@sparkelf/dsh-dataops-admin/SKILL.md
```

**建议把这两段加进部署脚本的收尾检查**，否则它会是那种
"装了三个月，其实一直没生效，直到有人问为什么 AI 不会管账号"的问题。

### 需要同步改的脚本

若走仓库脚本部署（**仅当选了上面的路径 1、包进了 `profile.bundles` 时**）：

- `/root/projects/dataops/infra/docker-workspace/workspace-dev.sh`
  → 两处（第 121、128 行）的 `for PKG in dsh-better-sidebar @sparkelf/dsh-knowledge-base;`
  循环，末尾加 `@sparkelf/dsh-dataops-admin`

`align-substituted-profile.mjs` 的 `REQUIRED_BUNDLES` **不需要加**：该清单只要求
"装了就必须有 bundle 行"的包，而本包当前没有 bundle 行。**如果按路径 1 补了 Host 半边
+ `cordis.patch.yml`，那时才应该加进 `REQUIRED_BUNDLES`**，否则 bundle 行丢了没人发现。

## 测试

```bash
npx vitest run packages/dataops-admin    # 56 passed
```

核心逻辑（请求构造、登录判定、超管门禁、脱敏）都是纯函数，测试不打网络。
