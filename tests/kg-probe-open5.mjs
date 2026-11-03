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
await page.waitForTimeout(2500)
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
  const layout = c.get('layout')
  const right = c.get('sidebarRight')
  const out = {}
  try { layout.openRightbar(true, false); out.layout = 'called' } catch (e) { out.layout = 'ERR:' + String(e).slice(0, 200) }
  try { right.openResourceIn(sid, 'dsh-resource://file/absolute/workspace/kb/global/checkRule.sh', {}); out.in = 'called' } catch (e) { out.in = 'ERR:' + String(e).slice(0, 200) }
  try { out.expanded = right.isExpanded() } catch (e) { out.expanded = 'ERR' }
  return out
})
console.log('CALL', JSON.stringify(res))
await page.waitForTimeout(2500)
const state = await frame.evaluate(() => {
  const cols = [...document.querySelectorAll('[class*=rightbar],[class*=Rightbar],aside')].map(e => ({ cls: String(e.className).slice(0, 50), text: (e.textContent || '').trim().slice(0, 120) }))
  return { bodyHasPlaceholder: (document.body.innerText || '').includes('已在右侧文件窗口中打开'), cols }
})
console.log('STATE', JSON.stringify(state, null, 2))
await page.screenshot({ path: '/root/projects/dsh-ui-shots/kg-open-probe5.png' })
await browser.close()
