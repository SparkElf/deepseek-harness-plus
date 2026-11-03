import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
const page = await ctx.newPage()
page.on('requestfailed', r => console.log('REQFAIL', r.url(), r.failure()?.errorText))
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)) })
await page.goto('http://localhost:3000/?test=true', { waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(10000)
await page.locator('input').nth(0).fill('admin', { force: true })
await page.locator('input[type=password]').fill('DataOps!2026', { force: true })
await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
await page.waitForTimeout(8000)
await page.goto('http://localhost:3000/ai/dsh', { waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(18000)
const frame = page.frames().find(f => f.url().includes(':32000') && !f.url().includes('/knowledge-base/'))
await frame.getByText('知识库', { exact: true }).first().click()
await page.waitForTimeout(2000)
await frame.getByRole('tab', { name: '图谱', exact: true }).click()
await page.waitForTimeout(3500)
const info = await frame.evaluate(() => {
  const iframe = document.querySelector('iframe[data-testid=kg-canvas-frame]')
  return {
    baseURI: document.baseURI,
    pageHref: location.href,
    attr: iframe?.getAttribute('src'),
    prop: iframe?.src,
    resolved: iframe ? new URL(iframe.getAttribute('src'), document.baseURI).href : null,
    frameCount: window.frames.length,
  }
})
console.log(JSON.stringify(info, null, 2))
for (const f of page.frames()) console.log('FRAME', f.url())
await page.screenshot({ path: '/root/projects/dsh-ui-shots/kg-iframe-probe.png' })
await browser.close()
