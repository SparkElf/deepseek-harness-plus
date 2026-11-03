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
  let fiber = el[key]
  if (fiber.current) fiber = fiber.current
  while (fiber.return) fiber = fiber.return
  const out = []
  const stack = [fiber]
  let seen = 0
  while (stack.length && seen < 80000) {
    const node = stack.pop(); seen++
    const type = node.type
    const name = typeof type === 'function' ? (type.name || type.displayName) : (typeof type === 'string' ? type : '')
    const props = node.memoizedProps
    if (props && typeof props === 'object' && (props.sessionSource || props.t || props.ctx) && /Knowledge|Panel|Slot|Renderer/.test(String(name))) {
      const c = props.ctx
      const probe = (n) => { try { const v = c?.get?.(n); return v === undefined ? 'undefined' : (typeof v + (typeof v === 'object' ? ':' + Object.keys(v).slice(0,8).join(',') : '') + (typeof v?.candidates === 'function' ? ' candidates=fn' : '')) } catch (e) { return 'ERR:' + String(e).slice(0,80) } }
      out.push({ name, hasCtx: !!c, hasT: !!props.t, tabs: c ? probe('sidebarRightTabs') : 'no-ctx', right: c ? probe('sidebarRight') : 'no-ctx', layout: c ? probe('layout') : 'no-ctx' })
    }
    if (node.child) stack.push(node.child)
    if (node.sibling) stack.push(node.sibling)
  }
  return { out: out.slice(0, 20), seen }
})
console.log(JSON.stringify(info, null, 2))
await browser.close()
