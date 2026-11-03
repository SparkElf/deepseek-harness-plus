import { chromium } from 'playwright'
const out = { errors: [], checks: {} }
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } })
page.on('pageerror', e => out.errors.push(String(e).slice(0, 160)))
const resp = await page.goto('http://127.0.0.1:19999/dsh/', { waitUntil: 'domcontentloaded', timeout: 60000 })
out.checks.status = resp ? resp.status() : null
await page.waitForTimeout(20000)
out.checks.title = await page.title()
const body = await page.evaluate(() => document.body.innerText.slice(0, 300))
out.checks.bodyHead = body
const nav = await page.evaluate(() => [...document.querySelectorAll('nav button')].map(e => (e.textContent||'').trim()).filter(Boolean))
out.checks.nav = nav
await page.screenshot({ path: '/root/projects/dsh-ui-shots/box-02-dsh.png' })
console.log(JSON.stringify(out, null, 1))
await browser.close()
