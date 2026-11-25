# Browser Headless

## 前置

- 工作区已安装 Playwright 和 Chromium；
- 检查：

```bash
node -e "console.log(require.resolve('playwright'))"
```

- 不需要安装无头浏览器；缺依赖时才报告。

## 工作流

1. 明确目标 URL、要抓的字段/表格、是否需要登录；
2. 在 `/workspace/outputs/browser/<task>/` 写 `scrape.mjs`；
3. headless 启动 Chromium；
4. 登录（仅使用凭据插件注入的环境变量）；
5. 等待页面稳定，优先抓接口返回/表格，不只看 DOM；
6. 保存 `result.json` + `screenshot.png`；
7. 校验条数/字段，再把摘要回复用户。

## 脚本模板

```js
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');

const out = '/workspace/outputs/browser/task';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

try {
  await page.goto(process.env.TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  if (process.env.BROWSER_USERNAME) {
    await page.fill('input[autocomplete="username"], input[name="username"]', process.env.BROWSER_USERNAME);
    await page.fill('input[type="password"]', process.env.BROWSER_PASSWORD);
    await page.click('button[type="submit"], button:has-text("登录")');
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  }

  const rows = await page.locator('table tbody tr').evaluateAll((trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.trim())));

  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ url: page.url(), rows }, null, 2));
  await page.screenshot({ path: path.join(out, 'screenshot.png'), fullPage: true });
  console.log(JSON.stringify({ ok: true, rows: rows.length, out }));
} finally {
  await browser.close();
}
```

按实际页面替换选择器；不要硬编码不存在的按钮。

## 登录与凭据

- 用户账号密码先存凭据插件；
- 脚本只读环境变量：
  - `BROWSER_USERNAME`
  - `BROWSER_PASSWORD`
- 不把密码写入脚本、日志、截图；
- 登录失败/验证码/短信时停止并询问用户；
- 不自动切 Companion。

## 大屏抓取

- 先看页面是否直接暴露 JSON 接口；优先 `page.waitForResponse`/接口抓取；
- 表格：抓 `tbody tr`；图表：优先接口数据，不要 OCR；
- 需要点击切换 tab 时，每次点击后校验数据变化；
- 动态加载等待 `networkidle` 或目标元素出现；
- 保存完整 HTML 仅用于调试，不作为最终数据。

## 安全

- 只访问用户给出的域名；
- 禁止 localhost/127.0.0.1/169.254.169.254/内网管理端口；
- 并发 1，超时 60s；
- 独立 context，不持久化 cookie；
- 提交/下单/删除/发布前必须用户确认。

## 失败处理

| 现象 | 动作 |
|---|---|
| 401/403 | 检查凭据；仍失败则询问用户 |
| 验证码/短信 | 停止，询问；用户明确要求本地浏览器才走 companion |
| 页面结构变化 | 重新快照，调整选择器；不要猜数据 |
| 数据为空 | 检查接口/筛选条件，报告空结果，不伪造 |

## 输出

```text
/workspace/outputs/browser/<task>/
├── result.json
└── screenshot.png
```

回复用户：数据条数、字段、来源 URL、异常；不要把整页 HTML 贴进回答。
