import { chromium } from 'playwright'
const out = { errors: [], checks: {} }
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
page.on('pageerror', e => out.errors.push(String(e).slice(0, 160)))
await page.goto('http://127.0.0.1:19999/?test=true', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(12000)
await page.locator('input').nth(0).fill('admin', { force: true })
await page.locator('input[type=password]').fill('DataOps!2026', { force: true })
await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
await page.waitForTimeout(8000)
await page.goto('http://127.0.0.1:19999/ai/dsh', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(25000)
const frame = page.frames().find(f => f.url().includes('/dsh/'))
out.checks.frame = Boolean(frame)
if (frame) {
  const nav = await frame.evaluate(() => [...document.querySelectorAll('nav button')].map(e => (e.textContent||'').trim()).filter(Boolean))
  out.checks.nav = nav
  out.checks.noPluginEntry = !nav.some(t => /插件|Plugins?/.test(t))
  const body = await frame.evaluate(() => document.body.innerText)
  out.checks.hasKnowledgeBase = /知识库|Knowledge base/.test(body)
}
await page.screenshot({ path: '/root/projects/dsh-ui-shots/box-01-home.png' })
console.log(JSON.stringify(out, null, 1))
await browser.close()
