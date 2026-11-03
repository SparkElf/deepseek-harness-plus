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
  row.click(); await sleep(1500)  // open the file -> tab
  const tab = [...d.querySelectorAll('[class*=tab]')].find(e => (e.textContent || '').trim() === 'test-menu.md' && /_tab_/.test(String(e.className)))
  if (!tab) return 'no-tab'
  const r = tab.getBoundingClientRect()
  tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10, button: 2 }))
  await sleep(800)
  const items = [...d.querySelectorAll('[role=menuitem], [class*=menuItem], [class*=MenuItem]')].map(e => (e.textContent || '').trim()).filter(Boolean)
  const item = [...d.querySelectorAll('[role=menuitem], [class*=menuItem], [class*=MenuItem]')].find(e => (e.textContent || '').trim() === '打开所在位置')
  if (!item) return JSON.stringify({ items })
  item.click(); await sleep(1500)
  const footer = [...d.querySelectorAll('*')].find(e => e.children.length === 0 && (e.textContent || '').includes('已选择'))
  const selRow = d.querySelector('[class*=explorerRow][class*=Selected], [data-dsh-selected]')
  return JSON.stringify({ items, footer: footer ? footer.textContent.trim().slice(0, 24) : null, selRow: selRow ? (selRow.textContent || '').trim().slice(0, 20) : null, cls: selRow ? String(selRow.className).slice(0, 70) : null })
})
console.log(out)
await page.screenshot({ path: '/root/projects/dsh-ui-shots/tab-reveal.png' })
await browser.close()
