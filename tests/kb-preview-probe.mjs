import { chromium } from 'playwright'
const S = '/root/projects/dsh-ui-shots/'
const out = { errors: [], info: {} }
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
page.on('pageerror', e => out.errors.push(String(e).slice(0, 160)))
page.on('console', m => { if (m.type() === 'error') out.errors.push('console: ' + m.text().slice(0, 120)) })
await page.goto('http://127.0.0.1:3000/?test=true', { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForTimeout(8000)
await page.locator('input').nth(0).fill('admin', { force: true })
await page.locator('input[type=password]').fill('DataOps!2026', { force: true })
await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
await page.waitForTimeout(6000)
await page.goto('http://127.0.0.1:3000/ai/dsh', { waitUntil: 'domcontentloaded', timeout: 90000 })
let dsh = null
for (let i = 0; i < 10; i++) { await page.waitForTimeout(6000); dsh = page.frames().find(f => f !== page.mainFrame() && /dsh|32000/.test(f.url())); if (dsh && (await dsh.evaluate(() => document.querySelectorAll('nav button').length)) > 0) break }
if (!dsh) { console.log('no dsh frame'); process.exit(1) }
await dsh.getByText('知识库', { exact: true }).first().click({ timeout: 9000 })
await page.waitForTimeout(8000)
// 展开全局并点一个文件
const treeDump = await dsh.evaluate(() => {
  const rows = [...document.querySelectorAll('[class*=explorerRow],[class*=treeRow],[role=treeitem]')].slice(0, 15)
  return rows.map(r => ({ t: (r.textContent || '').trim().slice(0, 30), cls: String(r.className).slice(0, 40) }))
})
out.info.treeRows = treeDump
await page.screenshot({ path: S + 'kb-preview-01-tree.png' })
// 点击第一个文件行
const clicked = await dsh.evaluate(() => {
  const rows = [...document.querySelectorAll('[class*=explorerRow],[role=treeitem]')]
  const file = rows.find(r => /\.md|\.docx|\.txt/.test(r.textContent || ''))
  if (!file) return 'no-file-row'
  file.click()
  return (file.textContent || '').trim().slice(0, 40)
})
out.info.clicked = clicked
await page.waitForTimeout(6000)
out.info.after = await dsh.evaluate(() => {
  const txt = document.body.innerText
  const panes = [...document.querySelectorAll('[class*=pane],[class*=sidebar],[class*=dock]')].map(e => ({ cls: String(e.className).slice(0, 40), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) })).slice(0, 10)
  return { hasOpenedHint: /已在右侧|文件窗口中打开/.test(txt), panes, bodyHead: txt.slice(0, 200).replace(/\n/g, ' | ') }
})
await page.screenshot({ path: S + 'kb-preview-02-after.png' })
console.log(JSON.stringify(out, null, 1))
await browser.close()
