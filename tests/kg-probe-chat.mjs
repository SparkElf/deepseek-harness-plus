import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
const page = await ctx.newPage()
await page.goto('http://127.0.0.1:3000/?test=true', { waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(10000)
await page.locator('input').nth(0).fill('admin', { force: true })
await page.locator('input[type=password]').fill('DataOps!2026', { force: true })
await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
await page.waitForTimeout(8000)
await page.goto('http://127.0.0.1:3000/ai/dsh', { waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(18000)
const frame = page.frames().find(f => f.url().includes(':32000') && !f.url().includes('/knowledge-base/'))
const info = await frame.evaluate(() => ({
  textareas: [...document.querySelectorAll('textarea')].map(e => ({ ph: e.placeholder, cls: String(e.className).slice(0,50) })),
  editables: [...document.querySelectorAll('[contenteditable=true]')].map(e => ({ cls: String(e.className).slice(0,50), text: (e.textContent||'').slice(0,30) })),
  buttons: [...document.querySelectorAll('button')].map(e => ({ aria: e.getAttribute('aria-label'), text: (e.textContent||'').trim().slice(0,20), cls: String(e.className).slice(0,40) })).filter(b => b.aria || b.text).slice(-20),
}))
console.log(JSON.stringify(info, null, 2))
await browser.close()
