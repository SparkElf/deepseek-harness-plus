# @sparkelf/dsh-artifact-app

DataOps 驾驶舱（Artifact App）在 DSH 右侧栏的入口：驾驶舱列表、沙箱查看器、HTML 文件预览、模板 / 组件 / 驾驶舱模型工具、外部驾驶舱注册表发现与 Host 登录（M1/M2）和 `artifact-app-authoring` 技能。

## 组成

| 部分 | 作用 |
| --- | --- |
| `GET /dsh-artifact-app/config` | 客户端读取 render / gateway 地址与 tab type |
| `GET /dsh-artifact-app/token` | 同源页面读取当前工作区 DataOps token（只用于 postMessage 注入 iframe） |
| `GET /dsh-artifact-app/apps` | 驾驶舱列表代理（浏览器不持有读接口 token） |
| `POST /dsh-artifact-app/preview` | HTML 文件预览：按文件路径建/复用草稿 |
| `GET /dsh-artifact-app/render/:id` | 取 HTML、校验合同、注入主题 / ECharts / runtime，返回 `text/html` + CSP |
| `GET /dsh-artifact-app/gateway/api/artifact-apps/:id/{query,call-api}` | 沙箱 HTML 唯一出口；只代理这两个网关接口，带 CORS |
| `GET /dsh-artifact-app/open/events` | SSE：`open_cockpit` / `cockpit_updated`，客户端据此开 tab、刷新查看器 |
| `GET /dsh-artifact-app/external-cockpits` | 外部驾驶舱注册表列表代理（search / tag / page / pageSize） |
| `GET /dsh-artifact-app/external-cockpits/:id` | 外部驾驶舱详情代理 |
| `POST /dsh-artifact-app/external-cockpits/:id/link` | 取稳定链接代理；只返回 HTTPS URL，不返回 ticket / Cookie |
| `GET /dsh-artifact-app/external-cockpits/:id/credentials` | 按 `credential_type` + 站点 origin 列出 credential-manager 元数据；无 secret |
| `POST /dsh-artifact-app/external-cockpits/:id/login` | Host 内 Playwright 登录；显式 `mode=headed` 才用有头；返回会话 id / 截图地址 |
| `GET /dsh-artifact-app/external-cockpits/:id/sessions/:sessionId/screenshot` | 返回会话 PNG；会话按浏览器 client id 与 TTL 绑定 |
| `DELETE /dsh-artifact-app/external-cockpits/:id/sessions/:sessionId` | 立即结束会话并清空 storageState / 截图 |

## 工具

内部资产：`artifact_template_list`、`artifact_template_get`、`artifact_template_publish`、`component_search`、`component_read`、`cockpit_list`、`cockpit_get`、`cockpit_publish`、`cockpit_open`、`cockpit_update`、`cockpit_delete`（插件审批）、`cockpit_grant`。

外部注册表（M1）：`external_cockpit_search(query?, tag?, limit?)`、`external_cockpit_get(id)`、`external_cockpit_link(id)`。三个工具只接受搜索词或注册表 id，不接受任意 URL；返回内容只有展示元数据和稳定链接，不含 secret / Cookie / login recipe / launch ticket。

没有 `cockpit_create` / `cockpit_save_html` / `cockpit_preview`：草稿就是工作区里的 HTML 文件。

## 客户端

- 右侧栏 tab `dataops-artifact-apps`（标题「驾驶舱」）：内部分段「内部资产」+「外部驾驶舱」。
- 「内部资产」保留原有应用 / 模板 / 组件列表和沙箱 iframe 查看器；外部来源永远不会进入该 iframe。
- 「外部驾驶舱」：注册表列表、关键词搜索、打开稳定链接（新窗口）、复制链接；空态、加载态、错误重试，以及新窗口未出现时的手动降级链接。
- HTML 文件查看器：只匹配 `/artifact-apps/**/*.html` 且文件头含 `<meta name="artifact-app" content="cockpit">`；打开即建/复用预览草稿并渲染。
- `OpenCockpitBridge`：SSE → `betterSidebar.openTab` / `updateTab`。

## 外部驾驶舱（M1）

范围是「注册表发现 + 链接」：注册、编辑、权限和审计都在 DataOps 门户 / API，插件只读。

DataOps 侧契约（插件按此调用，后端 M1 需保持一致）：

```text
GET  /api/external-cockpits?search=&tag=&page=&pageSize=
     → { items: ExternalCockpit[], total, page, pageSize }
GET  /api/external-cockpits/:id
     → ExternalCockpit
POST /api/external-cockpits/:id/link
     → { id, url, expiresAt? }        # url 必须是绝对 HTTPS 地址
```

`ExternalCockpit` 中插件会读取并可返回给模型 / 页面的字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 注册表 id（字母、数字、`_`、`-`，最长 64）；不是 URL |
| `name` / `description` | 展示信息 |
| `url` | 外部驾驶舱目标地址；不是 HTTPS 时插件置空 |
| `tags` / `ownerId` / `visibility` | 标签、负责人、`PRIVATE` / `DEPARTMENT` / `ALL` |
| `credentialType` / `credentialHint` | `http` / `custom` / `none` 与账号提示（无密码） |
| `enabled` / `health` / `updatedAt` | 启用状态、最近探测、更新时间 |

后端多返回的 `loginRecipe`、`allowedOrigins`、`cookie`、`token`、`password` 等字段不会进入插件输出。`link` 响应里的 `launchTicket` / `ticket` 同样被丢弃；只有稳定 `url` 会被使用，且必须是 HTTPS。

对接点：

- 认证复用本插件已有的 DataOps JWT：`credentialRef`（默认 `DATAOPS_ACCESS_TOKEN`）→ `ArtifactApi.request` 的 `Authorization: Bearer`，不新增 secret。
- 权限仍在 DataOps：读接口按设计使用 `artifact-app:read`（或后端最终确定的等价权限），插件不复刻可见性规则。
- 后端返回体直接是对象（与 `/api/artifact-apps` 一致），不使用额外的 `{code,data}` 包装。
- 若后端返回 401，插件沿用现有逻辑上报 `/integrations/dataops/auth-state` 的 `expired` 状态。

## 外部驾驶舱（M2：凭据 + Host 登录 + 截图）

M2 在 M1 的注册表发现之上增加一条最小闭环：

```text
用户点「登录并截图」
→ 面板读取 /credentials（按 credential_type + 站点 origin 匹配）
→ 用户选择凭据
→ Host 从 credential-manager 的 Host-only service 读取 secret
→ Playwright（默认 headless）新建隔离 context，执行 login recipe
→ 成功：截图 + storageState（仅进程内存，TTL）→ 面板显示截图 / 打开原站
→ 失败：MFA/验证码返回明确 code + headed 接管提示
```

### 登录 recipe

Registry 详情可选返回 `loginRecipe`；否则使用插件配置 `externalLoginRecipes[<registry-id>]`（管理员在 cordis.yml 提供，模型和页面都不能写 recipe）：

```json
{
  "version": 1,
  "steps": [
    { "action": "goto", "url": "{{url}}" },
    { "action": "fill", "selector": "input[name=username]", "value": "{{username}}" },
    { "action": "fill", "selector": "input[type=password]", "value": "{{password}}" },
    { "action": "click", "selector": "button[type=submit]" },
    { "action": "waitForURL", "pattern": "**/dashboard" }
  ],
  "success": { "selector": "[data-cockpit-ready]" },
  "timeoutMs": 30000
}
```

- 动作：`goto` / `fill` / `click` / `waitForSelector` / `waitForURL` / `wait`（`selector`、`url` 或 `ms` 之一）；
- 占位符：`{{url}}`、`{{username}}`、`{{password}}`、`{{token}}`、`{{secret}}`、`{{secondary}}`；真实值只在 Host 内解析；
- recipe 不允许任意 JS、任意 URL、控制字符或未闭合占位符；`goto` 只允许 `{{url}}` 或 allowlist 内的 HTTPS 绝对地址；
- recipe 不是 secret 容器：管理员不要把密码/令牌写成字面量，凭据字段只用占位符。

### 安全边界

- 只接受注册表 id，不接受任意 URL；目标必须是 HTTPS，导航只允许 `allowedOrigins`（缺省为驾驶舱 origin）；
- 每个登录新建 browser context；不共享 cookie jar；storageState / 截图只存 Host 内存，按 TTL 过期并可在面板「结束会话」立即清空；
- 子资源只允许 HTTPS/WSS 与公网主机；loopback、私网、link-local、云元数据地址被拒绝；HTTP 一律拦截；
- secret 不进入模型、页面、URL、日志或审计；审计只有 `cockpitId`、`credentialId`、模式、结果和耗时；
- 默认 headless；`mode: "headed"` 必须由用户显式选择，且部署可用 `externalHeadedEnabled: false` 关闭；
- 面板用随机 browser-session id 绑定会话；DSH Host 没有按用户主体验证的请求 seam，因此这不等同于多租户身份认证。

M2 仍不包含：实时 CDP screencast、launch ticket 消费、DataOps 注册表写入 recipe 的 UI、MFA 的自动处理。M3 再评估实时查看与 headed 接管体验。

## 配置

```yaml
- insert:
    - id: artifact-app
      name: '@sparkelf/dsh-artifact-app'
      config:
        baseUrl: http://host.docker.internal:3101   # DataOps API
        webBaseUrl: ''                              # 浏览器可达的 DataOps 前端；空则用请求 origin
        credentialRef: DATAOPS_ACCESS_TOKEN         # 与 dataops-managed 共用
        htmlMaxBytes: 2097152
        injectRuntime: true
        workspaceRoot: /workspace                   # html_path 的相对根
        requestTimeoutMs: 30000
        externalSessionTtlMs: 900000                # 登录会话（截图/storageState）内存 TTL
        externalMaxSessions: 20                     # 保留的会话上限，超出淘汰最旧
        externalLoginTimeoutMs: 45000               # 单次 recipe 总预算
        externalHeadedEnabled: true                 # false 时拒绝显式 headed
        externalBrowserChannel: ''                  # 例如 chrome；空则用 Playwright 自带浏览器
        externalLoginRecipes: {}                    # 可选：按 registry id 提供 M2 recipe
```

## 安全

- 驾驶舱 HTML 视为不可信内容：iframe `sandbox="allow-scripts"`（opaque origin），CSP 禁止外链，只放行 DSH origin 的 gateway。
- token 不进 HTML、不进 URL；由父页面 `postMessage` 注入运行时闭包，401 时重取并重发。
- 发布前校验 `window.artifactApp`、`artifactApp.ready()`、`data-slot="charts"`、无外链资源、≤ `htmlMaxBytes`；缺项返回 `TEMPLATE_CONTRACT_MISSING`。
- 授权始终在 DataOps API：插件不复刻权限规则；技能按 `artifact-app:create` 披露。
- 外部驾驶舱只接受注册表 id（`external.ts` 的 id 正则），拒绝 URL、路径和控制字符；所有目标链接只允许 `https:`。外部页面不使用 iframe，不用 Cookie，不把 ticket / secret 返回给模型。
- M2 登录只从注册表详情或管理员配置读取 recipe；模型工具不新增登录入口，secret 不经过模型。Playwright 是可选 peer（`playwright` / `playwright-core`），未安装时返回 `BROWSER_UNAVAILABLE`，插件仍可加载。

## 开发

```bash
npm test           # vitest：API / 工具 / 面板 / broker（recipe、TTL、MFA、allowlist）/ 路由
npm run build      # tsdown：lib/index.js + lib/client.js
npm run typecheck
```
