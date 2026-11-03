import { chromium } from 'playwright'
import fs from 'node:fs'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
const page = await ctx.newPage()
page.on('console', m => { if (m.type() === 'error') console.log('PAGE-ERR', m.text().slice(0, 300)) })
await page.goto('http://127.0.0.1:8080/?test=true', { waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(12000)
await page.locator('input').nth(0).fill('admin', { force: true })
await page.locator('input[type=password]').fill('DataOps!2026', { force: true })
await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
await page.waitForTimeout(8000)
await page.goto('http://127.0.0.1:8080/ai/dsh', { waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(18000)
const frame = page.frames().find(f => f.url().includes('/dsh/'))
if (!frame) { console.log('NO DSH FRAME'); await browser.close(); process.exit(1) }
const row = frame.getByRole('button', { name: '自动化任务', exact: true })
console.log('ROW COUNT', await row.count())
await row.first().click({ force: true })
await page.waitForTimeout(5000)
await page.screenshot({ path: '/root/projects/dsh-ui-shots/plaza-before.png' })
const dump = await frame.evaluate(() => {
  const clean = s => (s || '').trim().replace(/\s+/g, ' ')
  const tabs = [...document.querySelectorAll('[role=tab], [class*=tab]')].map(e => ({ cls: String(e.className).slice(0, 80), text: clean(e.textContent).slice(0, 40), role: e.getAttribute('role') })).filter(x => x.text)
  const heads = [...document.querySelectorAll('h1,h2,h3,[class*=title],[class*=header]')].map(e => ({ tag: e.tagName, cls: String(e.className).slice(0, 80), text: clean(e.textContent).slice(0, 80) })).filter(x => x.text).slice(0, 80)
  const plaza = [...document.querySelectorAll('[class*=plaza], [class*=Plaza]')].map(e => ({ cls: String(e.className).slice(0, 100), text: clean(e.textContent).slice(0, 100) }))
  const hasPlazaText = document.body.innerText.includes('广场')
  const btns = [...document.querySelectorAll('button')].map(e => ({ cls: String(e.className).slice(0, 60), text: clean(e.textContent).slice(0, 40), aria: e.getAttribute('aria-label') || '' })).filter(x => x.text || x.aria).slice(0, 100)
  // main content region: biggest text container after clicking
  const main = document.querySelector('main') || document.querySelector('[class*=page]') || document.body
  return { bodyText: document.body.innerText.slice(0, 6000), tabs, heads, plaza, hasPlazaText, btns, mainHTML: main.outerHTML.slice(0, 12000) }
})
fs.writeFileSync('/tmp/plaza-dom.json', JSON.stringify(dump, null, 1))
console.log('HAS-PLAZA-TEXT', dump.hasPlazaText)
console.log('TABS', JSON.stringify(dump.tabs, null, 1))
console.log('HEADS', JSON.stringify(dump.heads, null, 1))
console.log('PLAZA NODES', JSON.stringify(dump.plaza, null, 1))
console.log('BODY:\n' + dump.bodyText)
await browser.close()