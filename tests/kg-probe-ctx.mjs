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
await page.waitForTimeout(15000)
const frame = page.frames().find(f => f.url().includes(':32000'))
const info = await frame.evaluate(() => {
  const m = window.__dshSidebarModuleSystem__
  const out = { type: typeof m, keys: m ? Object.keys(m) : [], proto: m ? Object.getOwnPropertyNames(Object.getPrototypeOf(m)) : [] }
  try { out.string = String(m).slice(0, 300) } catch (_) {}
  const loader = window.__ModuleLoader__
  try { out.loaderManifest = loader?.manifest ?? null } catch (e) { out.loaderErr = String(e) }
  return out
})
console.log(JSON.stringify(info, null, 2))
// Try to find a client context on DOM / React roots
const info2 = await frame.evaluate(() => {
  const keys = []
  for (const el of document.querySelectorAll('*')) {
    for (const k of Object.keys(el)) {
      if (k.startsWith('__react') && !keys.includes(k)) keys.push(k)
    }
  }
  return { reactKeys: keys.slice(0, 10) }
})
console.log(JSON.stringify(info2, null, 2))
await browser.close()
