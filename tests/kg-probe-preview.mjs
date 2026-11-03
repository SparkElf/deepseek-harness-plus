import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('PAGEERR', String(e).slice(0, 300)))
await page.goto('http://127.0.0.1:3000/?test=true', { waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(10000)
await page.locator('input').nth(0).fill('admin', { force: true })
await page.locator('input[type=password]').fill('DataOps!2026', { force: true })
await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
await page.waitForTimeout(8000)
await page.goto('http://127.0.0.1:3000/ai/dsh', { waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(18000)
const frame = page.frames().find(f => f.url().includes(':32000') && !f.url().includes('/knowledge-base/'))
await frame.getByText('知识库', { exact: true }).first().click()
await page.waitForTimeout(2500)
await frame.getByText('checkRule.sh', { exact: true }).first().dblclick()
await page.waitForTimeout(3000)
const info = await frame.evaluate(() => ({
  previews: [...document.querySelectorAll('[data-testid=kg-file-preview]')].map(e => ({text: (e.innerText||'').slice(0,200), cls: e.className})),
  bodyHasPreview: (document.body.innerText||'').includes('关闭预览'),
  bodyHasPlaceholder: (document.body.innerText||'').includes('已在右侧文件窗口中打开'),
  bodyTail: (document.body.innerText||'').slice(-800),
  contentArea: [...document.querySelectorAll('[class*=content]')].map(e => ({cls:String(e.className).slice(0,50), text:(e.innerText||'').slice(0,120)})).slice(0,5),
}))
console.log(JSON.stringify(info, null, 2))
await page.screenshot({ path: '/root/projects/dsh-ui-shots/kg-preview-probe.png' })
await browser.close()
