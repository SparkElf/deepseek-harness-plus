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
const input = frame.locator('[contenteditable=true]').first()
await input.click()
await page.keyboard.type('只调用一次 kg_get 工具，参数为空对象 {}，然后把工具返回的原始 JSON 原样贴出来。不要做别的事。', { delay: 5 })
await frame.getByRole('button', { name: '发送消息' }).click()
await page.waitForTimeout(5000)
for (let i = 0; i < 24; i++) {
  const text = await frame.evaluate(() => document.body.innerText)
  if (text.includes('"overview"') || text.includes('kg_get') && text.includes('工具')) {
    console.log('HIT at', i, text.slice(-1200)); break
  }
  await page.waitForTimeout(2500)
}
await page.screenshot({ path: '/root/projects/dsh-ui-shots/kg-tool-probe-1.png' })
console.log('TAIL', (await frame.evaluate(() => document.body.innerText)).slice(-2000))
await browser.close()
