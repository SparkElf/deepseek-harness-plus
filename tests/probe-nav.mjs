import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] })
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
const frame = page.frames().find(f => f.url().includes('/dsh/'))
if (!frame) { console.log('NO-FRAME', page.frames().map(f=>f.url())); process.exit(0) }
const out = await frame.evaluate(() => {
  const want = ['插件','技能中心','自动化任务']
  const found = []
  for (const el of document.querySelectorAll('a,button,div,span,li')) {
    const txt = (el.textContent || '').trim()
    if (!want.includes(txt)) continue
    if (el.children.length > 2) continue
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    const chain = []
    let n = el
    for (let i = 0; i < 7 && n; i++) {
      chain.push({ tag: n.tagName, cls: String(n.className).slice(0, 70), role: n.getAttribute && n.getAttribute('role'), id: n.id || '', aw: n.getAttribute && (n.getAttribute('aria-label')||''), href: n.getAttribute && (n.getAttribute('href')||'') })
      n = n.parentElement
    }
    found.push({ txt, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), chain })
  }
  return JSON.stringify(found, null, 1)
})
console.log(out)
await page.screenshot({ path: '/root/projects/dsh-ui-shots/nav-probe.png' })
await browser.close()
