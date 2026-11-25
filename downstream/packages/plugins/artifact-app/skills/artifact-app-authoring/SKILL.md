---
name: artifact-app-authoring
description: 根据数据资源制作驾驶舱 / 大屏 / 看板，或修改已有驾驶舱时使用。包含模板选择、data-slot 填写、artifactApp 运行时约束、HTML 文件预览和发布前用户确认；没有用户明确同意不得发布。
metadata:
  permissions:
    - artifact-app:create
---

# 驾驶舱（Artifact App）制作

用户要把一个数据资源做成驾驶舱、大屏或看板时用本技能。你只写「内容区」：模板负责布局、视觉和运行时，插件 host 负责注入 ECharts、SDK、CSP 和 token。

## 一、什么时候用

- 根据资源做驾驶舱 / 大屏 / 看板 / 经营盘
- 把这个资源做成可视化
- 更新这个驾驶舱 / 加一个图表 / 改一个指标
- 用某个模板做一个驾驶舱

不适用：纯问数取数（用 `dataops-query`）；只是要一张静态图（用图表工具）。

## 二、硬规则

1. **先选模板，不要从零写 HTML。** 先 `artifact_template_list`，按业务场景选一个；再 `artifact_template_get` 拿骨架和 `data-slot` 契约。
2. **只填 `data-slot`。** 不改 `window.artifactApp` 运行时，不删 required markers，不改模板的布局与 CSS 变量。
3. **HTML 写到固定目录**：`/workspace/artifact-apps/<slug>.html`，文件头必须有
   `<meta name="artifact-app" content="cockpit">`，
   建议同时写 `<meta name="artifact-app-template" content="<templateId>@<version>">`。
4. **取数统一走运行时**：
   - 表：`artifactApp.query({ sources, sql, maxRows })`，`sources` 必须是 `[{ resourceRef, alias }]`（不是字符串数组）；
   - 已登记 API：`artifactApp.callApi({ operationRef, args })`；
   - 自定义请求：`artifactApp.fetch('/api/...')`。
   HTML 里不写 token，不手写 `Authorization`。
5. **轮询统一用 `artifactApp.every(intervalMs, fn)`**，不要自己写 `setInterval` / `setTimeout`。
6. **图表用 `artifactApp.chart(el, option)`**；使用全局 `echarts`，不要引 CDN。
7. **状态用 `artifactApp.ui.loading/empty/error/noPermission`**；403 用 `artifactApp.requestAccess(resourceRef)`。
8. **格式化用 `artifactApp.format.number/percent/currency/date`**；配置从 `artifactApp.config` 读；启动时调 `artifactApp.ready()`。
9. **发布必须用户明确确认。** 先让用户看到预览，问「确认发布吗？」；只有用户明确说「发布 / 确认」后才调用 `cockpit_publish`。

## 二·补、组件参考库（component_search / component_read）

- **先判断模板能否覆盖。** 如果模板里已经把这个图表、地图或交互控件实现得很好，直接在模板实现上改数据/文案/样式，**没有必要**再查组件库。
- 只有当「模板中没有该组件、或模板里的实现达不到需求，且你自己不确定怎么写」时，才调用 `component_search`（按 tags/能力/关键词）检索，再用 `component_read` 读参考实现。
- 还没选模板时不要查组件库——先 `artifact_template_list` 看模板库。
- 组件是**参考代码**，不是可实例化模板：不要把组件 id 当 `template_id` 传给 `cockpit_publish` / `cockpit_preview`。
- 改造模板已有组件时，优先在模板实现上改，不要整段替换。

## 三、禁止

- 直接 `fetch('/api/...')`、手写 `Authorization`、读取或打印 token。
- 用 `setInterval` / `setTimeout` 做轮询。
- 访问 `window.parent`、`localStorage`、`sessionStorage`、`document.cookie`、`indexedDB`。
- 外链 `script` / `img` / `font` / CDN / `@import url(http...)`。
- 把 token、内网 IP、数据库名写进 HTML。
- 删除或改写 `window.artifactApp`、`data-slot` 标记、模板的 required markers。
- 写 `/workspace/artifact-apps/` 之外的文件。
- 调 auth、用户 / 角色 / 部门管理、工作区生命周期接口。
- 未经用户确认调 `cockpit_publish` / `cockpit_delete` / `cockpit_grant`。

## 四、流程

1. **确认资源与口径**：复用 `dataops-query` 的选表策略；`describe_resource` 看字段，`execute_sql` 聚合确认口径；不要拉明细全量。
2. **选模板**：`artifact_template_list` → 按场景选一个 → `artifact_template_get`。
3. **写 HTML**：在模板上填 `data-slot` 内容（KPI、图表容器、表格、榜单）、查询调用与 ECharts option。
4. **写文件**：写到 `/workspace/artifact-apps/<slug>.html`，带 `artifact-app` 标记。
5. **预览**：从文件树打开这个 HTML。插件文件查看器会自动建/复用草稿并渲染真实数据；不要另调预览工具（没有 `cockpit_preview`）。
6. **改**：用户提修改就直接改同一个 HTML 文件，重新打开/刷新预览。
7. **改刷新频率 / 保持连接**：用户说「每分钟刷一次」→ `cockpit_update` 改 `refresh_interval_seconds`；说「打开后保持连接」→ `keep_connection=true`。默认保持连接是 false，不要主动打开。
8. **发布**：用户确认后 `cockpit_publish({ html_path, name?, description?, catalog?, template_id?, template_version?, artifact_id? })`。不带 `artifact_id` 是新建发布；带 `artifact_id` 是发新版本。
9. **分享**：用户明确指定主体后才 `cockpit_grant`；删除必须先让用户确认，`cockpit_delete` 会再走一次插件审批。

## 五、HTML 合同

- 基于 `artifact_template_get` 返回的骨架写；只填 slot，不改运行时。
- 首屏 skeleton；每块数据独立处理 loading / 空 / 无权限 / 失败，不要因为一个接口失败整页白屏。
- 无权限的图表用骨架模板的「暂无权限 + 申请权限」，按钮调 `artifactApp.requestAccess(resourceRef)`；不在共享前做预检。
- 401 由运行时处理：自动向父页面要新 token 重试一次；仍 401 显示「登录已过期」，可用 `artifactApp.on('token:expired', fn)` 感知。
- 适配窄栏：`width:100%`、`height:100%`、CSS Grid、`clamp()` 字号。
- 中文标签；金额/百分比带单位和千分位。
- 不在 HTML 源码里出现 token、内网 IP、数据库名。

## 六、取数示例

```js
artifactApp.ready();

artifactApp.every(artifactApp.config.refreshIntervalSeconds * 1000, async () => {
  artifactApp.ui.loading(document.getElementById('trend'), '加载中…');
  try {
    const payload = await artifactApp.query({
      sources: [{ resourceRef: 'urn:dataops:resource:123', alias: 'sales' }],
      sql: 'SELECT month, SUM(amount) AS amount FROM sales GROUP BY month ORDER BY month',
      maxRows: 500
    });
    artifactApp.chart(document.getElementById('trend'), {
      xAxis: { type: 'category', data: payload.rows.map(row => row[0]) },
      yAxis: { type: 'value' },
      series: [{ type: 'line', data: payload.rows.map(row => row[1]) }]
    });
  } catch (error) {
    artifactApp.ui.error(document.getElementById('trend'), '取数失败：' + error.message);
  }
});
```

## 七、模板清单怎么选

- 警务：警情态势 / 案件侦办 / 治安巡防 / 重点人员场所管控。
- 商业：经营大屏 / 通行运营 / 投资与项目 / 销售经营。
- 没有现成业务主题：`blank`。

按「用户打开这个驾驶舱想问的问题」选，不按图表类型选。

## 八、模板包：目录化 + 素材托管

从 v0.1.x 起，驾驶舱模板可以直接以**目录包**形式发布，素材不再必须内联进 HTML。

### 目录结构

```
<template-id>/
├── template.json     # { id, name, description?, catalog?, slots[], question?, theme? }
├── template.html     # 内联 CSS；素材用 asset://<逻辑名> 引用
└── assets/           # 可选
    ├── logo.png
    └── nanning.geojson
```

- **逻辑名 = 文件名去掉后缀**：`assets/logo.png` → `asset://logo`；
- 支持的类型：`.png .jpg .jpeg .webp .svg .json .geojson .woff2 .css .js .html`；
- 单文件 ≤ 32 MB，整包解压后 ≤ 100 MB，文件数 ≤ 200；
- **不要**在包里放 `node_modules`、隐藏文件或可执行文件。

### 为什么优先用素材而不是 base64

| 方式 | 体积 | 缓存 | 适用 |
| --- | --- | --- | --- |
| base64 内联 | 每份驾驶舱都背全部图片 | 无 | 单文件分发（离线发出去） |
| `asset://` + assets/ | HTML 只有几十 KB | `immutable` 长缓存、多应用共享 | 平台内正常浏览 |

**默认用 `asset://`**；只有明确要「导出一个能离线打开的 HTML」时才依赖导出时的内联。

### 发布流程

1. 在 workspace 里建好 `<template-id>/` 目录（template.json + template.html + assets/）；
2. 调工具 `artifact_template_publish({ directory: '<template-id>' })`；
3. 服务端会：解 zip → 校验（路径穿越/体积/后缀/SVG 脚本）→ 素材按内容寻址落盘 → 建模板版本；
4. 之后用 `artifact_app_create` / `artifact_app_publish` 引用该 `template_id` 建应用。

### 素材解析顺序（渲染时）

```
应用版本 own  →  模板 assets/（按 templateId）  →  shared
```

- 应用想换一张图，把同名素材挂到应用版本即可覆盖，其他继续沿用模板的；
- 模板升级不会自动改变已建应用（应用版本冻结模板版本号），要同步得显式调
  `artifact_app_upgrade_template`。

### 导出

| 模式 | 产物 | 用途 |
| --- | --- | --- |
| `inline` | 单 HTML（素材 + runtime + ECharts 全内联） | 邮件/网盘/离线 |
| `external` | zip（index.html + assets/） | 部署到静态服务器 |
