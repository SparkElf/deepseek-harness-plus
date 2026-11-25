# @sparkelf/dsh-artifact-app

DataOps 驾驶舱（Artifact App）在 DSH 右侧栏的入口：驾驶舱列表、沙箱查看器、HTML 文件预览、9 个模型工具和 `artifact-app-authoring` 技能。

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

## 工具

`artifact_template_list`、`artifact_template_get`、`cockpit_list`、`cockpit_get`、`cockpit_publish`、`cockpit_open`、`cockpit_update`、`cockpit_delete`（插件审批）、`cockpit_grant`。

没有 `cockpit_create` / `cockpit_save_html` / `cockpit_preview`：草稿就是工作区里的 HTML 文件。

## 客户端

- 右侧栏 tab `dataops-artifact-apps`（标题「驾驶舱」）：列表 + 沙箱 iframe 查看器。
- HTML 文件查看器：只匹配 `/artifact-apps/**/*.html` 且文件头含 `<meta name="artifact-app" content="cockpit">`；打开即建/复用预览草稿并渲染。
- `OpenCockpitBridge`：SSE → `betterSidebar.openTab` / `updateTab`。

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

## 开发

```bash
npm run build      # tsdown：lib/index.js + lib/client.js
npm run typecheck
```