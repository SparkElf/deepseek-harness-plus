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
const frame = page.frames().find(f => f.url().includes(':32000'))
await frame.getByText('知识库', { exact: true }).first().click()
await page.waitForTimeout(3000)
const res = await frame.evaluate(() => {
  const el = document.querySelector('#root') || document.body
  const key = Object.keys(el).find(k => k.startsWith('__reactContainer$'))
  let fiber = el[key]; if (fiber.current) fiber = fiber.current; while (fiber.return) fiber = fiber.return
  let c = null
  const stack = [fiber]
  while (stack.length && !c) {
    const node = stack.pop(); const t = node.type; const name = typeof t === 'function' ? (t.name || '') : ''
    if (name === 'KnowledgePanel' && node.memoizedProps?.ctx) c = node.memoizedProps.ctx
    if (node.child) stack.push(node.child); if (node.sibling) stack.push(node.sibling)
  }
  const snap = c.get('uiSession')?.adapter?.current?.getSnapshot?.() ?? {}
  const sid = snap.key
  const right = c.get('sidebarRight')
  const address = 'dsh-resource://file/absolute/workspace/kb/global/checkRule.sh'
  let out = {}
  try { right.openResourceIn(sid, address, {}); out.call = 'called' } catch (e) { out.call = 'ERR:' + String(e).slice(0, 200) }
  return out
})
console.log('CALL', JSON.stringify(res))
await page.waitForTimeout(2500)
const state = await frame.evaluate(() => {
  const col = document.querySelector('[class*=rightbarCol]')
  return { colText: (col?.innerText || '').slice(0, 300), bodyHasRule: (document.body.innerText || '').includes('checkRule.sh'), tabs: [...document.querySelectorAll('[class*=tab]')].filter(e => (e.textContent || '').includes('checkRule')).map(e => (e.textContent || '').trim().slice(0, 40)) }
})
console.log('STATE', JSON.stringify(state))
await page.screenshot({ path: '/root/projects/dsh-ui-shots/kg-open-probe4.png' })
await browser.close()
