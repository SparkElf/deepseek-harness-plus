import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('PAGEERR', String(e).slice(0, 300)))
await page.goto('http://127.0.0.1:3000/?test=true', { waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(10000)
await page.locator('input').nth(0).fill('admin', { force: true })
await page.locator('input[type=password]').fill('DataOps!2026', { force: true })
await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
await page.waitForTimeout(8000)
await page.goto('http://127.0.0.1:3000/ai/dsh', { waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(15000)
const frame = page.frames().find(f => f.url().includes(':32000'))
console.log('frame', frame?.url())
const globals = await frame.evaluate(() => ({ keys: Object.keys(window).filter(k => /dsh|DSH|module/i.test(k)).slice(0, 30), loader: Object.keys(window.__ModuleLoader__ || {}) }))
console.log('globals', JSON.stringify(globals))
await frame.locator('button').filter({ hasText: /^知识库$/u }).first().click()
await page.waitForTimeout(3000)
const info = await frame.evaluate(() => {
  const text = document.body.innerText
  const rows = [...document.querySelectorAll('[role=button]')].filter(e => (e.textContent || '').includes('知识图谱') || (e.textContent || '').includes('部门/')).slice(0, 10).map(e => ({ cls: String(e.className).slice(0, 40), text: (e.textContent || '').trim().slice(0, 80) }))
  return { tabs: [...document.querySelectorAll('[role=tab]')].map(e => ({ text: (e.textContent || '').trim(), selected: e.getAttribute('aria-selected') })), rows, snippet: text.slice(0, 1600) }
})
console.log(JSON.stringify(info, null, 2))
await page.screenshot({ path: '/root/projects/dsh-ui-shots/kg-3000-kb.png' })
// click definitions.md file if visible
const file = frame.getByText('definitions.md', { exact: true }).first()
console.log('file count', await file.count())
if (await file.count()) { await file.click(); await page.waitForTimeout(2500) }
const after = await frame.evaluate(() => {
  const text = document.body.innerText
  const right = [...document.querySelectorAll('[class*=right],[class*=Right],aside')].map(e => ({ tag: e.tagName, cls: String(e.className).slice(0,60), text: (e.textContent||'').trim().slice(0,80) })).slice(0,12)
  return { hasPlaceholder: text.includes('已在右侧文件窗口中打开'), hasDefinitions: text.includes('definitions.md'), snippet: text.slice(-1200), right }
})
console.log(JSON.stringify(after, null, 2))
await page.screenshot({ path: '/root/projects/dsh-ui-shots/kg-3000-preview.png' })
await browser.close()
