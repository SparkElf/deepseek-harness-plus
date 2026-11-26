# @sparkelf/dsh-artifact-app

DataOps 驾驶舱（Artifact App）在 DSH 右侧栏的入口：驾驶舱列表、沙箱查看器、HTML 文件预览、模板 / 组件 / 驾驶舱模型工具、外部驾驶舱注册表发现（M1）和 `artifact-app-authoring` 技能。

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

M2（未实现）：凭据选择、Playwright / headless 登录、storageState TTL、launch ticket 消费、截图或实时查看器、headed 接管。本插件的 M1 工具和页面不会索取密码、Cookie 或 token，也不会把 launch ticket 回传给模型。

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
```

## 安全

- 驾驶舱 HTML 视为不可信内容：iframe `sandbox="allow-scripts"`（opaque origin），CSP 禁止外链，只放行 DSH origin 的 gateway。
- token 不进 HTML、不进 URL；由父页面 `postMessage` 注入运行时闭包，401 时重取并重发。
- 发布前校验 `window.artifactApp`、`artifactApp.ready()`、`data-slot="charts"`、无外链资源、≤ `htmlMaxBytes`；缺项返回 `TEMPLATE_CONTRACT_MISSING`。
- 授权始终在 DataOps API：插件不复刻权限规则；技能按 `artifact-app:create` 披露。
- 外部驾驶舱只接受注册表 id（`external.ts` 的 id 正则），拒绝 URL、路径和控制字符；所有目标链接只允许 `https:`。外部页面不使用 iframe，不用 Cookie，不把 ticket / secret 返回给模型。

## 开发

```bash
npm test           # vitest：API mock、工具拒绝任意 URL / 非法 id、列表与空/错误态
npm run build      # tsdown：lib/index.js + lib/client.js
npm run typecheck
```
