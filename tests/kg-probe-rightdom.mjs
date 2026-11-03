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
  layout.openRightbar(true, false)
  right.openResourceIn(sid, 'dsh-resource://file/absolute/workspace/kb/global/checkRule.sh', {})
  const col = document.querySelector('[class*=rightbarCol]')
  const r = col?.getBoundingClientRect()
  const active = (() => { try { return right.active() } catch (e) { return 'ERR:' + String(e) } })()
  const adopted = right.adopted?.get?.(sid)
  return {
    sid, active: active === undefined ? 'undefined' : String(active).slice(0, 200),
    col: r ? { x: Math.round(r.x), width: Math.round(r.width), height: Math.round(r.height), display: getComputedStyle(col).display, opacity: getComputedStyle(col).opacity } : null,
    colHtml: col ? col.outerHTML.slice(0, 1500) : null,
    adoptedKeys: adopted ? Object.keys(adopted).slice(0, 20) : null, storeProto: adopted?.store ? Object.getOwnPropertyNames(Object.getPrototypeOf(adopted.store)).slice(0, 40) : null, storeKeys: adopted?.store ? Object.keys(adopted.store).slice(0, 30) : null, actionKeys: adopted?.store?.actions ? Object.keys(adopted.store.actions).slice(0, 40) : null, snapshot: adopted?.store?.getSnapshot ? Object.keys(adopted.store.getSnapshot() || {}).slice(0,20) : null, rightMounted: (() => { try { const m = right.mounted?.(); return m ? Object.keys(m).slice(0,20) : null } catch (e) { return 'ERR' } })(),
  }
})
console.log(JSON.stringify(res, null, 2))
await page.screenshot({ path: '/root/projects/dsh-ui-shots/kg-rightdom.png' })
await browser.close()
