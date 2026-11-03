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
await page.waitForTimeout(2500)
const info = await frame.evaluate(() => {
  const el = document.querySelector('#root') || document.body
  const key = Object.keys(el).find(k => k.startsWith('__reactContainer$'))
  let fiber = el[key]; if (fiber.current) fiber = fiber.current; while (fiber.return) fiber = fiber.return
  let panelCtx = null
  const stack = [fiber]
  while (stack.length && !panelCtx) {
    const node = stack.pop(); const t = node.type; const name = typeof t === 'function' ? (t.name || '') : ''
    if (name === 'KnowledgePanel' && node.memoizedProps?.ctx) panelCtx = node.memoizedProps.ctx
    if (node.child) stack.push(node.child); if (node.sibling) stack.push(node.sibling)
  }
  const ctx = panelCtx
  const describe = (v) => {
    if (v === undefined) return 'undefined'
    if (v === null) return 'null'
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(v) || {}).filter(n => n !== 'constructor')
    return { type: typeof v, version: String(v.version ?? ''), proto: proto.slice(0, 30).join(',') }
  }
  const bs = ctx.get('betterSidebar')
  const uiSession = ctx.get('uiSession')
  let current = null
  try { const adapter = uiSession?.adapter?.current; current = adapter?.getSnapshot?.() ?? adapter?.get?.() ?? null } catch (e) { current = 'ERR:' + String(e) }
  const right = ctx.get('sidebarRight')
  const result = { bs: describe(bs), current: current === null ? 'null' : (typeof current === 'object' ? JSON.stringify(Object.fromEntries(Object.entries(current).filter(([k,v]) => ['key','id','cwd','title'].includes(k) || typeof v === 'string'))) : String(current)), right: describe(right), tabs: describe(ctx.get('sidebarRightTabs')) }
  try { result.openRight = (() => { right.openResource('dsh-resource://file/absolute/workspace/kb/global/checkRule.sh'); return 'called' })() } catch (e) { result.openRight = 'ERR:' + String(e).slice(0, 300) }
  try { result.openBs = (() => { bs.openFile({ sessionId: current?.key || 'x', cwd: '/workspace' }, '/workspace/kb/global/checkRule.sh'); return 'called' })() } catch (e) { result.openBs = 'ERR:' + String(e).slice(0, 300) }
  return result
})
console.log(JSON.stringify(info, null, 2))
await page.waitForTimeout(1500)
await page.screenshot({ path: '/root/projects/dsh-ui-shots/kg-open-probe.png' })
await browser.close()
