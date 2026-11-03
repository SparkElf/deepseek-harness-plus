import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] })
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('PAGEERR', String(e).slice(0,300)))
await page.goto('http://127.0.0.1:3000/?test=true', { waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(12000)
await page.locator('input').nth(0).fill('admin', { force: true })
await page.locator('input[type=password]').fill('DataOps!2026', { force: true })
await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
await page.waitForTimeout(8000)
await page.goto('http://127.0.0.1:3000/ai/dsh', { waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(18000)
const frame = page.frames().find(f => f.url().includes(':32000') && !f.url().includes('/knowledge-base/'))
await frame.getByText('知识库', { exact: true }).first().click()
await page.waitForTimeout(2000)
console.log('tabs', await frame.getByRole('tab').allTextContents())
await frame.getByRole('tab', { name: '图谱', exact: true }).click()
await page.waitForTimeout(5000)
console.log('tabs2', await frame.getByRole('tab').allTextContents())
const info = await frame.evaluate(() => ({
  tree: document.querySelector('[data-testid=kg-tree]')?.getBoundingClientRect(),
  loading: document.querySelector('[data-testid=kg-tree-loading]')?.innerText,
  failed: document.querySelector('[data-testid=kg-tree-failed]')?.innerText,
  empty: document.querySelector('[data-testid=kg-tree-empty]')?.innerText,
  body: (document.body.innerText||'').slice(-1000),
}))
console.log(JSON.stringify(info,null,2))
await page.screenshot({ path: '/root/projects/dsh-ui-shots/kg-graphtab-probe.png' })
await browser.close()
