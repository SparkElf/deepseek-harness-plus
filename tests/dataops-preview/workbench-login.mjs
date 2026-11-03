#!/usr/bin/env node
/**
 * DataOps 预览门户登录 → 打开 AI 工作台 的端到端检查。
 *
 * 运行（在 deepseek-harness-plus 仓库根目录，playwright 已安装）：
 *   node tests/dataops-preview/workbench-login.mjs
 *
 * 可用环境变量覆盖：
 *   DATAOPS_PREVIEW_URL       默认 http://127.0.0.1:8080
 *   DATAOPS_PREVIEW_USER      默认 admin
 *   DATAOPS_PREVIEW_PASSWORD  默认 DataOps!2026
 *   DATAOPS_PREVIEW_SHOTS     默认 <repo>/.cache/dataops-preview-shots
 *
 * 断言：
 *   1. 登录后进入门户首页（出现“晚上好”/用户名）。
 *   2. /ai/dsh 出现 DSH 工作台（“无法启动”不出现），并截图为证。
 *   3. 任何 console error / requestfailed 都会打印，供排查。
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const BASE = process.env.DATAOPS_PREVIEW_URL ?? 'http://127.0.0.1:8080'
const USER = process.env.DATAOPS_PREVIEW_USER ?? 'admin'
const PASSWORD = process.env.DATAOPS_PREVIEW_PASSWORD ?? 'DataOps!2026'
const SHOTS = process.env.DATAOPS_PREVIEW_SHOTS ?? join(resolve('.'), '.cache/dataops-preview-shots')
mkdirSync(SHOTS, { recursive: true })

const errors = []
const browser = await chromium.launch({
  executablePath: process.env.DATAOPS_PREVIEW_CHROME ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
const page = await context.newPage()
page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
page.on('requestfailed', request => errors.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`))

let failed = false
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

try {
  // 1. 登录（?test=true 打开账号密码表单）
  await page.goto(`${BASE}/?test=true`, { waitUntil: 'domcontentloaded', timeout: 40_000 })
  await page.waitForTimeout(12_000)
  await page.locator('input').nth(0).fill(USER, { force: true })
  await page.locator('input[type=password]').fill(PASSWORD, { force: true })
  await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
  await page.waitForTimeout(10_000)
  const home = await page.locator('body').innerText()
  await page.screenshot({ path: join(SHOTS, 'portal-home.png') })
  check(home.includes('晚上好') || home.includes(USER), '登录进入门户首页', page.url())

  // 2. 打开 AI 工作台
  await page.goto(`${BASE}/ai/dsh`, { waitUntil: 'domcontentloaded', timeout: 40_000 })
  await page.waitForTimeout(25_000)
  const workbench = await page.locator('body').innerText()
  await page.screenshot({ path: join(SHOTS, 'workbench.png') })
  const unavailable = workbench.includes('DSH AI 工作台暂时不可用') || workbench.includes('无法启动 DSH AI 工作台')
  // DSH 工作台在 /dsh/ iframe 内：以 iframe 自己的正文为准，外层的“无法启动”只用于报错。
  const frame = page.frames().find(candidate => candidate.url().includes('/dsh/'))
  let frameText = ''
  for (let attempt = 0; attempt < 30 && frame; attempt += 1) {
    try { frameText = await frame.locator('body').innerText() } catch { frameText = '' }
    if (frameText.includes('探索未至之境') || frameText.includes('新会话')) break
    await page.waitForTimeout(2_000)
  }
  const loaded = frame !== undefined && (frameText.includes('探索未至之境') || frameText.includes('新会话'))
  check(!unavailable && loaded, 'AI 工作台加载', unavailable
    ? workbench.slice(0, 120).replace(/\n+/g, ' | ')
    : (loaded ? 'dsh iframe ok' : 'dsh iframe 未出现工作台内容'))
  if (loaded) await page.screenshot({ path: join(SHOTS, 'workbench-dsh.png') })

  if (errors.length > 0) {
    console.log('--- browser errors ---')
    for (const error of errors.slice(0, 10)) console.log(error)
  }
} catch (error) {
  failed = true
  console.error('FAIL exception —', error instanceof Error ? error.message : String(error))
} finally {
  await browser.close()
}
process.exit(failed ? 1 : 0)
