import { chromium } from 'playwright'
const S = '/root/projects/dsh-ui-shots/'
const out = { errors: [], checks: {} }
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
page.on('pageerror', e => out.errors.push(String(e).slice(0, 140)))
await page.goto('http://127.0.0.1:3000/?test=true', { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForTimeout(8000)
await page.locator('input').nth(0).fill('admin', { force: true })
await page.locator('input[type=password]').fill('DataOps!2026', { force: true })
await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
await page.waitForTimeout(8000)
await page.goto('http://127.0.0.1:3000/ai/dsh', { waitUntil: 'domcontentloaded', timeout: 90000 })
let frame = null
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(8000)
  frame = page.frames().find(f => f.url().includes('/dsh'))
  if (frame) break
  out.checks['wait' + i] = (await page.evaluate(() => document.body.innerText)).slice(0, 40).replace(/\n/g, ' ')
}
out.checks.frame = Boolean(frame)
if (frame) {
  out.checks.nav = await frame.evaluate(() => [...document.querySelectorAll('nav button')].map(e => (e.textContent || '').trim()).filter(Boolean))
  out.checks.noPlugin = !out.checks.nav.some(t => /插件|Plugins/.test(t))
  await page.screenshot({ path: S + 'dev-01-home.png' })
  const clickNav = async (label) => {
    await frame.getByText(label, { exact: true }).first().click({ timeout: 8000 })
    await page.waitForTimeout(6500)
  }
  try { await clickNav('自动化任务'); out.checks.plaza = /工作流广场/.test(await frame.evaluate(() => document.body.innerText)); await page.screenshot({ path: S + 'dev-02-automation.png' }) } catch (e) { out.checks.automationErr = String(e).slice(0, 60) }
  try {
    await clickNav('技能中心')
    const tabs = await frame.evaluate(() => [...document.querySelectorAll('[role=tab]')].map(e => (e.textContent || '').trim()))
    out.checks.skillTabs = tabs
    const conn = tabs.find(t => /连接器/.test(t))
    if (conn) { await frame.getByRole('tab', { name: conn }).first().click({ timeout: 6000 }); await page.waitForTimeout(3000); out.checks.connectorLen = await frame.evaluate(() => document.body.innerText.length) }
    await page.screenshot({ path: S + 'dev-03-skillcenter.png' })
    const plazaTab = tabs.find(t => /技能广场/.test(t))
    if (plazaTab) { await frame.getByRole('tab', { name: plazaTab }).first().click({ timeout: 6000 }); await page.waitForTimeout(3500); await page.screenshot({ path: S + 'dev-04-plaza.png' }) }
  } catch (e) { out.checks.skillErr = String(e).slice(0, 60) }
  try {
    await clickNav('知识库')
    await frame.getByText('图谱', { exact: true }).first().click({ timeout: 6000 })
    await page.waitForTimeout(6000)
    out.checks.graph = /条线|篇关系/.test(await frame.evaluate(() => document.body.innerText))
    await page.screenshot({ path: S + 'dev-05-kg.png' })
  } catch (e) { out.checks.graphErr = String(e).slice(0, 60) }
}
console.log(JSON.stringify(out, null, 1))
await browser.close()
