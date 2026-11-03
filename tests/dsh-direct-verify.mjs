import { chromium } from 'playwright'
const S = '/root/projects/dsh-ui-shots/'
const BASE = process.env.DSH_BASE || 'http://127.0.0.1:3000/dsh/'
const out = { errors: [], checks: {} }
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
page.on('pageerror', e => out.errors.push(String(e).slice(0, 140)))
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForTimeout(20000)
out.checks.nav = await page.evaluate(() => [...document.querySelectorAll('nav button')].map(e => (e.textContent || '').trim()).filter(Boolean))
out.checks.noPlugin = !out.checks.nav.some(t => /插件|Plugins/.test(t))
await page.screenshot({ path: S + 'dev-01-home.png' })
const click = async (label) => { await page.getByText(label, { exact: true }).first().click({ timeout: 9000 }); await page.waitForTimeout(6500) }
try { await click('自动化任务'); out.checks.plaza = /工作流广场/.test(await page.evaluate(() => document.body.innerText)); await page.screenshot({ path: S + 'dev-02-automation.png' }) } catch (e) { out.checks.automationErr = String(e).slice(0, 60) }
try {
  await click('技能中心')
  const tabs = await page.evaluate(() => [...document.querySelectorAll('[role=tab]')].map(e => (e.textContent || '').trim()))
  out.checks.skillTabs = tabs
  const conn = tabs.find(t => /连接器/.test(t))
  if (conn) { await page.getByRole('tab', { name: conn }).first().click({ timeout: 6000 }); await page.waitForTimeout(3000); out.checks.connectorLen = await page.evaluate(() => document.body.innerText.length) }
  await page.screenshot({ path: S + 'dev-03-skillcenter.png' })
} catch (e) { out.checks.skillErr = String(e).slice(0, 60) }
try {
  await click('知识库')
  await page.getByText('图谱', { exact: true }).first().click({ timeout: 6000 })
  await page.waitForTimeout(6000)
  out.checks.graph = /条线|篇关系/.test(await page.evaluate(() => document.body.innerText))
  await page.screenshot({ path: S + 'dev-05-kg.png' })
} catch (e) { out.checks.graphErr = String(e).slice(0, 60) }
console.log(JSON.stringify(out, null, 1))
await browser.close()
