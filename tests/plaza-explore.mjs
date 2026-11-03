import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
const page = await ctx.newPage()
await page.goto('http://127.0.0.1:8080/?test=true', { waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(12000)
await page.locator('input').nth(0).fill('admin', { force: true })
await page.locator('input[type=password]').fill('DataOps!2026', { force: true })
await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
await page.waitForTimeout(8000)
await page.goto('http://127.0.0.1:8080/ai/dsh', { waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(18000)
console.log('TOP URL', page.url())
console.log('FRAMES', page.frames().map(f => f.url()))
const frame = page.frames().find(f => f.url().includes('/dsh/'))
if (!frame) { console.log('NO DSH FRAME'); await page.screenshot({ path: '/root/projects/dsh-ui-shots/plaza-before.png', fullPage: false }); await browser.close(); process.exit(0) }
await page.screenshot({ path: '/root/projects/dsh-ui-shots/plaza-before.png' })
const info = await frame.evaluate(() => {
  const out = []
  // clickable left rail / nav items
  for (const el of document.querySelectorAll('button, a, [role=button], [role=tab], [class*=rail], [class*=nav]')) {
    const t = (el.textContent || '').trim().replace(/\s+/g, ' ')
    if (t && t.length < 40) out.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), text: t, title: el.getAttribute('title') || '', aria: el.getAttribute('aria-label') || '' })
  }
  return { bodyText: document.body.innerText.slice(0, 4000), items: out.slice(0, 200) }
})
console.log('BODY TEXT:\n' + info.bodyText)
console.log('ITEMS:\n' + JSON.stringify(info.items, null, 1))
await browser.close()