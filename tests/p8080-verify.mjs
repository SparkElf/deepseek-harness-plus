import { chromium } from 'playwright'
const shots = '/root/projects/dsh-ui-shots/'
const out = { errors: [], checks: {} }
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
page.on('pageerror', e => out.errors.push(String(e).slice(0,150)))
await page.goto('http://127.0.0.1:8080/?test=true', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(12000)
await page.locator('input').nth(0).fill('admin', { force: true })
await page.locator('input[type=password]').fill('DataOps!2026', { force: true })
await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
await page.waitForTimeout(8000)
await page.goto('http://127.0.0.1:8080/ai/dsh', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(22000)
const frame = page.frames().find(f => f.url().includes('/dsh/'))
out.checks.frame = Boolean(frame)
if (!frame) { console.log(JSON.stringify(out)); await page.screenshot({path: shots+'p8080-fail.png'}); await browser.close(); process.exit(1) }
const nav = await frame.evaluate(() => [...document.querySelectorAll('nav button')].map(e => (e.textContent||'').trim()).filter(Boolean))
out.checks.nav = nav
await page.screenshot({ path: shots + 'p8080-01-sidebar.png' })
// automation tasks
try {
  await frame.getByText('自动化任务', { exact: true }).first().click({ timeout: 8000 })
  await page.waitForTimeout(7000)
  const t = await frame.evaluate(() => document.body.innerText)
  out.checks.plaza = /工作流广场/.test(t)
  await page.screenshot({ path: shots + 'p8080-02-automation.png' })
} catch (e) { out.checks.automationErr = String(e).slice(0,80) }
// skill center
try {
  await frame.getByText('技能中心', { exact: true }).first().click({ timeout: 8000 })
  await page.waitForTimeout(6000)
  const tabs = await frame.evaluate(() => [...document.querySelectorAll('[role=tab]')].map(e => (e.textContent||'').trim()))
  out.checks.skillTabs = tabs
  const conn = tabs.find(t => /连接器/.test(t))
  if (conn) {
    await frame.getByRole('tab', { name: conn }).first().click({ timeout: 6000 })
    await page.waitForTimeout(3500)
    out.checks.connectorLen = await frame.evaluate(() => document.body.innerText.length)
  }
  await page.screenshot({ path: shots + 'p8080-03-skillcenter.png' })
} catch (e) { out.checks.skillErr = String(e).slice(0,80) }
// knowledge base graph
try {
  await frame.getByText('知识库', { exact: true }).first().click({ timeout: 8000 })
  await page.waitForTimeout(7000)
  await frame.getByText('图谱', { exact: true }).first().click({ timeout: 6000 })
  await page.waitForTimeout(6000)
  const t = await frame.evaluate(() => document.body.innerText)
  out.checks.graph = /条线|篇关系/.test(t)
  await page.screenshot({ path: shots + 'p8080-04-kb-graph.png' })
} catch (e) { out.checks.graphErr = String(e).slice(0,80) }
console.log(JSON.stringify(out, null, 1))
await browser.close()
