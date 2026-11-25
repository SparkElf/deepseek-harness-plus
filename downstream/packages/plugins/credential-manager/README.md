# @sparkelf/dsh-credential-manager

DSH 右侧栏的第三方系统凭据清单。为 Prefect、DataOps、数据库、HTTP API、SSH 与自定义系统提供统一的元数据 CRUD、加密密钥存储、受审批保护的 AI 工具，以及一条**只做本地校验、不发起网络请求**的连接测试入口。

> 状态：MVP（0.1.0）。代码、测试、构建产物均在 `/root/projects/dsh-credential-manager`，**未安装到任何运行中的 profile，也未重启 DSH 服务**。

---

## 1. 它解决什么问题

DSH 里接第三方系统的插件越来越多，每个插件都在自己解决“地址放哪、密钥放哪、AI 怎么安全地创建和维护”。本插件把这件事收成一层：

- 右侧栏新增「凭据」页，按类型管理所有第三方系统凭据；
- 非敏感元数据（名称、类型、地址、端口、标签、启用状态）与加密 secret 严格分离；
- secret 只写不读：列表、详情、HTTP API、AI 工具都不会返回值；
- AI 通过 7 个工具增删改查，**每个工具都走审批**，删除还要 `confirm=true` + 精确名称；
- 为后续 `credential_request` / `credential_db_query` 预留接口与安全要求，但 MVP 不实现任意网络/数据库代理，避免 SSRF。

---

## 2. 功能

### 右侧栏

- 列表、搜索（名称/描述/类型/标签）、类型筛选；
- 创建 / 编辑 / 删除；
- 启用 / 停用；
- 测试连接入口（MVP 为本地配置校验，不联网）；
- 详情页展示连接信息、密钥字段的“已配置/未配置”、最近一次校验的逐项结果；
- 删除弹窗要求**手工输入完整凭据名称**才能确认；
- 所有密钥输入框为 `type=password`，保存成功后立即清空组件内状态，不回填、不缓存。

### 类型模板

| type | 默认认证 | 非敏感配置 | 密钥字段 |
|---|---|---|---|
| `prefect` | API Key / Basic | `apiUrl`、`workspace` | `apiKey`、`password` |
| `dataops` | Bearer Token | `baseUrl`、`tenant` | `token` |
| `database` | 用户名/密码 | `engine`、`host`、`port`、`database`、`username`、`ssl` | `password` |
| `http` | 无 / Bearer / Basic / Header | `baseUrl`、`username`、`headerName`、`timeoutMs` | `token`、`password`、`headerValue` |
| `ssh` | 密码 / 私钥 | `host`、`port`、`username` | `password`、`privateKey`、`passphrase` |
| `custom` | 自定义密钥 | `endpoint`、`secretLabel` | `secret`、`secondary` |

模板定义在 `src/templates.ts`，新增类型只需要加一条数据，不需要改存储或工具代码。

---

## 3. 安全模型

### 3.1 元数据与 secret 分离

| 数据 | 存放位置 | 是否加密 | 谁会读到 |
|---|---|---|---|
| 名称、类型、描述、标签、地址、端口、用户名、启用状态、`configuredSecretFields`（字段名） | `~/.dsh/credential-manager.json` | 否（本来就不敏感） | Host、UI、AI 工具 |
| secret 值 | `~/.dsh/workbench-vault.json`：namespace `credential-manager`，id 为凭据 UUID | 是（AES-256-GCM，密钥 `~/.dsh/workbench-vault.key`，`0600`） | 仅 Host（`readSecret`） |
| `secretRef`（环境变量名） | 元数据 JSON | 否（只是引用名） | Host、UI、AI 工具 |

原则：

- **元数据 JSON 永远不写 secret 值**，文件权限 `0600`；
- **列表/详情/工具输出永远不包含 secret 值**；
- **日志只记录字段名，不记录值**；审计事件形如
  `{ action, credentialId, name, type, detail: { secretFields: ['apiKey'] } }`；
- `readSecret(id)` 是 Host-only 方法，**没有**注册到 HTTP API，也**没有**注册成模型工具；未来的连接器只能从 Host 内部调用；
- 配置里的敏感键名（`password`、`token`、`apiKey`、`privateKey`…）会被拒绝，防止把密钥误写进元数据；
- 配置值里出现 `-----BEGIN` 会被拒绝；
- 读取磁盘上的旧元数据时会再做一次输出脱敏（防止手工改文件绕过校验）。

### 3.2 加密后端

生产路径使用 **@sparkelf/dsh-workbench-vault**：

- 共享文件 `~/.dsh/workbench-vault.json`，每个值用 AES-256-GCM 加密；
- 32 字节密钥在 `~/.dsh/workbench-vault.key`，权限 `0600`；
- namespace 固定为 `credential-manager`，与其它 Workbench 插件共享文件但互不覆盖；
- `apply()` 总是选择 vault，因此 `ctx.credentials` 不会收到本插件创建的原始 secret。

`CredentialManagerStore` 也接受 **`ctx.credentials` grant record** 作为备选后端（scope `credential-manager`，id `cred-<sha256(id) 前 32 位>`）。只有部署方的凭据提供方**保证加密落盘**时才应这样组合；本机 `dsh-credentials-local` 把 grant payload 写进 `0600` 的 YAML，并不加密内容，所以默认不把原始 secret 交给它。

`ctx.credentials` 仍然参与 `secret_ref`：`apply()` 用 `ctx.credentials.describe(credentialRef(name))` 只读取“是否已配置”，不读取值。

### 3.3 工具审批

`src/tools.ts` 中 7 个工具全部先调用审批门：

```ts
await approve({ toolName, exec, reason })
// outcome !== 'allowed-once' -> 直接失败
```

- 没有 `exec.agent` 的调用直接拒绝；
- 审批被拒绝、取消、不可用都会失败关闭；
- 删除的额外门槛：`confirm === true` **且** `confirm_name` 与当前名称完全一致；
- 删除先移除加密记录、再移除元数据；加密记录删除失败时整个删除中止并报错，不会留下“列表里没有、密钥还在”的孤儿；
- 工具描述明确告诉模型 `secret` 是 write-only、优先用 `secret_ref`。

### 3.4 为什么 MVP 不做“真连接测试”

`credential_test` 只做本地校验：必填配置、URL 协议、端口范围、TLS 开关、密钥是否已配置、`secret_ref` 是否可解析。返回：

```json
{
  "ok": true,
  "mode": "validation",
  "networkAttempted": false,
  "checks": [{ "id": "secret", "label": "密钥", "ok": true, "detail": "加密凭据已配置" }]
}
```

不向用户填写的地址发请求，因此不能被模型当作 SSRF 探测工具。

### 3.5 未来连接器的安全前提

`src/connectors.ts` 预留了 `CredentialRequestSeam` / `CredentialDbQuerySeam`，但**没有注册工具**。将来实现时必须满足：

- 目标 origin 来自凭据模板/元数据，不能由模型自由输入；
- scheme/host/port 走部署白名单；
- 禁止重定向；每一跳 DNS 结果检查 loopback、link-local、私网、云元数据地址，并固定到已校验 IP；
- 响应大小与时间上限，结果进模型前脱敏；
- `credential_db_query` 只允许单条只读语句、行数上限、超时；
- 两个操作都要显式审批，并写不含 secret / 完整响应体的审计。

---

## 4. AI 工具

| 工具 | 审批 | 行为 | 返回值 |
|---|---|---|---|
| `credential_list` | 是 | 按类型/关键词/启用状态列出 | 元数据数组，`count` |
| `credential_get` | 是 | 读一条凭据 | 元数据 + 类型模板字段名；**无 secret** |
| `credential_create` | 是 | 创建凭据；`secret` write-only | 元数据摘要 |
| `credential_update` | 是 | 更新元数据/轮换 secret；省略字段保持不变 | 元数据摘要 |
| `credential_delete` | 是 + 双确认 | 删除凭据和加密记录 | `{ deleted, secretCleanup }` |
| `credential_test` | 是 | 本地配置校验 | `{ ok, mode, networkAttempted:false, checks }` |
| `credential_templates` | 是 | 列出类型、配置字段、认证方式、密钥字段名 | 模板数组 |

`credential_create` 的 `secret` 与 `secret_ref` 互斥。推荐让用户先在 DSH 凭据里配置环境变量，再由 AI 传 `secret_ref`；这样 secret 不进入模型上下文。

> 注意：如果让 AI 直接传 `secret`，明文会出现在该次工具调用的会话记录里（插件本身不写日志、不写元数据、不回显，但无法删除上游的调用记录）。生产环境应优先用右侧栏录入，或使用 `secret_ref`。

### 删除契约（两层）

1. 工具层：`confirm: true` + `confirm_name` 精确匹配；
2. 存储层：`delete(id, { confirmed: true, name })` 再校验一次。

任一层不满足都拒绝，且不会先删 secret 再报错。

---

## 5. 安装与构建

### 前置

- DSH `0.2.1-rc.2`（Host 与 client 包版本见 `package.json`）
- Node `^22.19.0 || >=24`
- pnpm

### 构建与测试

```bash
cd /root/projects/dsh-credential-manager
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

产物：

```text
lib/index.js        Host ESM 入口
lib/index.d.ts      Host 类型
lib/client.js       浏览器 module-loader bundle
sparkelf-dsh-credential-manager-0.1.0.tgz
```

### 安装到 profile（本任务未执行）

```bash
dsh plugin --profile <profile> add ./sparkelf-dsh-credential-manager-0.1.0.tgz
```

该命令会读取 `package.json` 的 `dsh.bundle.patch`，把 `cordis.patch.yml` 的 `credential-manager` 行并入 profile。若走手工方式，在 profile 的 `cordis.patch.yml` 增加：

```yaml
- insert:
    - id: credential-manager
      name: '@sparkelf/dsh-credential-manager'
```

安装后按该部署的正常方式重启 DSH（不要直接 kill 进程；DataOps 工作区使用 `dataops-dsh-service`）。本任务没有执行安装或重启。

### 验证

1. 打开会话右侧栏，点“添加”选择「凭据」；
2. 新建一个 Prefect 凭据，填 `apiUrl` 和 API Key；
3. 保存后确认列表只显示“密钥已配置”，详情不回显值；
4. 点“测试”，应看到逐项本地校验结果和“未发起网络连接”；
5. 点“删除”，必须输入完整名称才能确认。

---

## 6. Host API

所有请求为同源 `POST /dsh-credential-manager/api/<method>`，JSON body，响应 `no-store`。

| method | body | 说明 |
|---|---|---|
| `state` | `{}` | 元数据列表 + 计算出的 `secretConfigured` |
| `templates` | `{}` | 类型模板 |
| `credentials.save` | `{ credential, secret? }` | 有 `credential.id` 为更新，否则创建 |
| `credentials.delete` | `{ credentialId, confirm: true, confirmName }` | 两层确认 |
| `credentials.toggle` | `{ credentialId, enabled }` | 启用/停用 |
| `credentials.test` | `{ credentialId }` | 本地校验 |

边界：

- 请求体上限 1 MiB；
- 错误响应只包含字段名/原因，不含 secret；
- 没有 CORS 头；跨源 JSON POST 会被浏览器预检拦截；
- 路由不提供“读 secret”方法。

---

## 7. 代码结构

```text
src/
  index.ts            Host 入口：HTTP API、工具注册、审计
  types.ts            共享类型（元数据 / 只写 secret / 校验结果）
  templates.ts        6 类模板与默认配置
  validation.ts       草稿、配置、secret 字段校验与输出脱敏
  store.ts            元数据 CRUD + 加密后端（vault 优先，credentials 备选）
  tools.ts            7 个受审批保护的模型工具
  connectors.ts       credential_request / credential_db_query 预留设计
  client/
    index.tsx         注册右侧栏 tab 与 guide
    CredentialsPane.tsx  列表/详情/表单/删除弹窗
    api.ts            同源 Host API 客户端
    model.ts          纯前端模型辅助
    i18n.tsx          中英文案
    CredentialsPane.module.css
tests/
  store.test.ts       元数据 CRUD、secret 隔离、vault 加密、校验、删除确认
  tools.test.ts       工具审批、secret 不出现在输出、删除双确认
  api.test.ts         Host API 映射、confirm=true、更新路径
  apply.test.ts       路由与 manifest 工具清单一致
```

---

## 8. 测试与构建结果（本机实测）

```text
pnpm typecheck  -> exit 0
pnpm test       -> 4 files, 19 tests passed
pnpm build      -> lib/index.js 54.2 KB; lib/client.js 959.5 KB（gzip 261 KB，含 react-icons）
```

覆盖点：

- secret 不出现在 `list` / `get` / `state` / 工具输出 / 元数据文件；
- WorkbenchVault 加密文件中不出现明文，`readSecret` 才能取回；同时配置 vault 与 credentials 时 vault 优先；
- 类型、必填配置、URL 协议、未知 secret 字段、重复名称、类型不可变；
- 删除：`confirmed=false`、名称不匹配、缺少 `confirm=true` 都拒绝；
- 元数据创建/读取/更新/启停/删除；
- 每个工具都调用审批；审批拒绝时 store 不发生变化；
- `credential_test` 的 `networkAttempted` 恒为 `false`；
- `apply` 注册的 7 个工具与 `dsh.plugin.json` 的 `contributes.tools` 完全一致；
- 真实 HTTP server 上的路由：保存/列表/删除/未知方法/非法 JSON/超大 body，响应不出现 secret。

---

## 9. 未实现 / 已知限制

- **没有真实连接测试**：Prefect/DataOps/数据库/SSH 都没有发网络请求；详情页明确写“本地校验”。
- **没有系统打通**：不拉 Prefect flow、不执行 DataOps API、不跑 SQL、不建 SSH 连接。
- **没有 `credential_request` / `credential_db_query` 工具**：只有接口与安全要求，见 `src/connectors.ts`。
- **类型不可变**：创建后不能把 `prefect` 改成 `ssh`，要新建。
- **无导入/导出、无批量操作、无密钥轮换历史**。
- **生产使用 WorkbenchVault**：`ctx.credentials` 只用于 `secret_ref` 解析；`dsh-credentials-local` 的 grant payload 不加密，故不作为原始 secret 后端。
- **WorkbenchVault 是共享文件**：同一 Host 进程内写入串行化，跨进程并发写没有额外文件锁。
- **UI 文案中文优先**，英文为回退；模板标签为中文（产品名除外）。
- **未安装到运行中的 profile**，因此没有真实 DSH 页面截图；`lib/client.js` 已通过构建，但尚未在 3080 上加载验证。
- `@deepseek-ai/dsh-agent` 因 peer 依赖被 pnpm 自动装成 `0.2.1-rc.4`；插件不直接 import 它。

---

## 10. 版本与兼容

- `peerDependencies` 声明 `>=0.2.1-rc.2`；
- Host 端只用 `ctx.webServer`、`ctx.tools`、`ctx.approval`、`ctx.credentials` 四个公开 seam，外加 `@sparkelf/dsh-workbench-vault` 的加密存储；
- Client 端只用 `ctx.slots`、`ctx.sidebarRightTabs`、`ctx.locale`，tab 注册遵循 `@deepseek-ai/dsh-client-ui-sidebar-right` 的 `id/kind/title/guide` 契约；
- CSS 颜色使用 `--dsw-alias-*` 主题 token，跟随 DSH 明暗主题。