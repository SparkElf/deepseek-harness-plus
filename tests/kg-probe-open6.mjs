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
  const sid = c.get('uiSession')?.adapter?.current?.getSnapshot?.()?.key
  const layout = c.get('layout'); const right = c.get('sidebarRight')
  const out = {}
  try { layout.openRightbar(true, false); out.layout = 'called' } catch (e) { out.layout = 'ERR:' + String(e).slice(0, 200) }
  try { right.openResourceIn(sid, 'dsh-resource://file/absolute/workspace/kb/global/checkRule.sh', {}); out.in = 'called' } catch (e) { out.in = 'ERR:' + String(e).slice(0, 200) }
  const store = right.adopted?.get?.(sid)?.store
  try { store.actions.setExpanded(sid, true); out.expand = 'called' } catch (e) { out.expand = 'ERR:' + String(e).slice(0, 200) }
  const snap = store.getSnapshot()
  out.snap = (() => { try { const s = snap.bySession?.[sid] ?? snap.bySession?.[Object.keys(snap.bySession||{})[0]]; return JSON.stringify({ keys: Object.keys(s||{}), layout: s?.layout ? { activePaneId: s.layout.activePaneId, tabs: Object.values(s.layout.tabs||{}).map(t => ({id:t.id,kind:t.kind,contentId:t.contentId,title:t.title})) } : null }).slice(0, 1200) } catch (e) { return 'ERR:'+String(e) } })()
  const tabEl = document.querySelector('[data-dockkit-content]')
  out.tab = tabEl?.getAttribute('data-dockkit-content')
  try { if (out.tab) store.actions.focusTab(sid, out.tab); out.focus = 'called' } catch (e) { out.focus = 'ERR:' + String(e).slice(0, 200) }
  return out
})
console.log('CALL', JSON.stringify(res))
await page.waitForTimeout(2500)
const state = await frame.evaluate(() => {
  const col = document.querySelector('[class*=rightbarCol]')
  const r = col?.getBoundingClientRect()
  const right = null
  return { col: r ? { x: Math.round(r.x), width: Math.round(r.width) } : null, text: (col?.innerText || '').slice(0, 300), html: (col?.innerHTML || '').slice(0, 1200), placeholder: (document.body.innerText || '').includes('已在右侧文件窗口中打开') }
})
console.log('STATE', JSON.stringify(state))
await page.screenshot({ path: '/root/projects/dsh-ui-shots/kg-open-probe6.png' })
await browser.close()
