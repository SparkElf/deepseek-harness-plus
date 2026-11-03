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
await frame.locator('button').filter({ hasText: /^知识库$/u }).first().click()
await page.waitForTimeout(3000)
const info = await frame.evaluate(() => {
  const el = document.querySelector('#root') || document.body
  const key = Object.keys(el).find(k => k.startsWith('__reactContainer$'))
  if (!key) return { error: 'no react root', keys: Object.keys(el).slice(0,5) }
  let fiber = el[key]
  // __reactContainer$ may be the HostRoot fiber or FiberRoot
  if (fiber.current) fiber = fiber.current
  while (fiber.return) fiber = fiber.return
  const found = []
  const funcs = new Set()
  const stack = [fiber]
  let seen = 0
  while (stack.length && seen < 60000) {
    const node = stack.pop(); seen++
    const props = node.memoizedProps
    if (props && typeof props === 'object') {
      for (const name of ['ctx', 'context', 'injected']) {
        const c = props[name]
        if (c && typeof c.get === 'function') {
          const probe = (n) => { try { const v = c.get(n); return v === undefined ? 'undefined' : (v === null ? 'null' : typeof v + (typeof v === 'object' ? ':' + Object.keys(v).slice(0,6).join(',') : '')) } catch (e) { return 'ERR:' + String(e).slice(0,60) } }
          found.push({ name, tabs: probe('sidebarRightTabs'), right: probe('sidebarRight'), layout: probe('layout'), uiWorkspace: probe('uiWorkspace'), fiber: String(c.fiber).slice(0,40) })
        }
      }
    }
    if (node.child) stack.push(node.child)
    if (node.sibling) stack.push(node.sibling)
  }
  return { key, found: found.slice(0, 10), seen }
})
console.log(JSON.stringify(info, null, 2))
await browser.close()
