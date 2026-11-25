---
name: browser
description: 浏览器自动化总入口。抓取网页/大屏/表格、登录后取数、或用用户本地 Chrome/Edge 操作内网系统时使用。默认工作区 Playwright headless；只有用户明确要求本地浏览器、已登录 Chrome 或 Companion 才走 Browser Bridge。包含 headless、Companion 桥接与旧 Chrome 安装排查三套按需参考。
---

# Browser

浏览器自动化只有一个入口。先按用户意图选模式，再按需读取对应参考；不要把两套运行方式混在一起，也不要用 curl/静态抓取冒充浏览器操作。

## 触发条件

- 抓取网页、大屏、表格、图表数据，或把页面结果整理成 JSON / 截图；
- 用给定账号密码登录后取数；
- 在用户自己的本地 Chrome/Edge 里打开内网系统、登录、点击、填表、截图；
- 需要用户扫码、短信验证码或 MFA 接管；
- 排查 Browser Bridge / Companion / 旧 Chrome 扩展的安装与连接问题。

## 先选模式

```text
默认：headless
只有用户明确要求本地浏览器或已登录 Chrome → companion
```

| 用户意图 | 模式 |
|---|---|
| “抓取这个大屏/网页/表格” | headless |
| 给了账号密码 | headless + 凭据插件 |
| “用我电脑上的浏览器” | companion |
| “用我已经登录的 Chrome” | companion |
| “用 companion” | companion |
| 需要扫码/短信/MFA 接管 | companion |

Agent 不得自行切换 companion；需要时先询问用户。

## 按需加载

主文件只负责路由和硬规则。进入某个模式后，再读取对应参考：

- **headless（默认）**：[references/headless.md](references/headless.md) — Playwright + Chromium 工作流、脚本模板、凭据登录、大屏抓取、失败处理、输出约定。
- **companion（本地浏览器）**：[references/bridge.md](references/bridge.md) — `browser_bridge_status` / `browser_bridge_connect` 探测、门户一键配对、`browser_*` 工具流程、安全边界与常见错误。
- **旧 Chrome 扩展安装/排查**：[references/chrome-install.md](references/chrome-install.md) — 已废弃的扩展安装流程，仅在排查旧环境时读取；脚本在 [references/scripts/](references/scripts/) 下。

## 通用硬规则

### 凭据

- 用户账号密码先存凭据插件，Agent 只拿 `secretRef`；
- 密码不得出现在 prompt、脚本、日志、截图；
- headless 通过环境变量/secretRef 登录；
- 登录失败、验证码或短信验证时停止并询问；不要自动切 companion。

### 安全

- headless 只访问用户明确给出的域名；禁止 localhost、127.0.0.1、169.254.169.254、内网管理端口；
- companion 只操作用户明确授权的域名，允许用户已登录的内网系统；授权边界见 [references/bridge.md](references/bridge.md)；
- 并发 1，默认超时 60s；
- 独立 context，不持久化 cookie；
- 提交、下单、删除、发布前必须用户确认；
- 不读取、不导出、不上传 Cookie、LocalStorage 或密码；不绕过验证码和风控。

### 成功判据

- 不以“点击成功”或“页面打开了”作为成功；必须校验数据条数、字段、接口状态或页面关键文本；
- 抓取结果同时写入 `result.json` 与 `screenshot.png`（路径见对应参考）；
- 页面为空或结构变化时报告事实，不猜数据、不伪造结果。

## 输出

```text
/workspace/outputs/browser/<task>/
├── result.json      # 数据、来源 URL、抓取时间
└── screenshot.png   # 关键页面
```

回复用户：数据条数、字段、来源 URL、异常；不要把整页 HTML 贴进回答。

## 相关技能

- `browser-cdp-automation`：接管真实 Chrome / CDP 的通用排障（本技能之外的环境问题）。
- `dataops-collect`：把抓到的表格/Excel/CSV 建成可问数的数据资源。