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
const frame = page.frames().find(f => f.url().includes('/dsh/'))
const out = await frame.evaluate(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const d = document
  const card = [...d.querySelectorAll('button[class*=paneCard]')].find(c => (c.textContent || '').includes('文件'))
  if (card) { card.click(); await sleep(1500) }
  const row = [...d.querySelectorAll('[class*=explorerRow]')].find(e => (e.textContent || '').includes('test-menu.md'))
  if (!row) return 'no-row'
  row.click(); await sleep(1500)
  const tab = [...d.querySelectorAll('[class*=tab]')].find(e => (e.textContent || '').trim() === 'test-menu.md' && /_tab_/.test(String(e.className)))
  if (!tab) return 'no-tab'
  const r = tab.getBoundingClientRect()
  tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10, button: 2 }))
  await sleep(700)
  const item = [...d.querySelectorAll('[role=menuitem], [class*=menuItem]')].find(e => (e.textContent || '').trim() === '打开所在位置')
  if (!item) return 'no-item'
  item.click(); await sleep(1500)
  const sels = [...d.querySelectorAll('[class*=explorerRowSelected]')].map(e => {
    const b = e.getBoundingClientRect()
    let n = e, panel = null
    for (let i = 0; i < 12 && n; i++) { if (/pane|panel|dock|explorerBody/.test(String(n.className))) { panel = String(n.className).slice(0, 40); break; } n = n.parentElement }
    return { text: (e.textContent || '').trim().slice(0, 18), x: Math.round(b.x), y: Math.round(b.y), panel }
  })
  const panes = [...d.querySelectorAll('[class*=explorerBody]')].map(e => { const b = e.getBoundingClientRect(); return { cls: String(e.className).slice(0, 40), x: Math.round(b.x), y: Math.round(b.y), h: Math.round(b.height) } })
  return JSON.stringify({ sels, panes })
})
console.log(out)
await page.screenshot({ path: '/root/projects/dsh-ui-shots/where-selected.png' })
await browser.close()
