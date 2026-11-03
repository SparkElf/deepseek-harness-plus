/**
 * Runtime verification for the 「工作流广场」 tab on the automation-task page.
 *
 * Usage (DataOps gateway, the 8080 style):
 *   BASE_URL=http://127.0.0.1:8080 node tests/plaza-verify.mjs
 *
 * Usage (a DSH instance exposed directly, e.g. a v19 container port):
 *   BASE_URL=http://127.0.0.1:3099 DSH_DIRECT=1 node tests/plaza-verify.mjs
 *
 * Optional:
 *   SHOT_PATH=/path/plaza-after.png       screenshot of the selected plaza tab
 *   DSH_USER / DSH_PASS                   gateway credentials (default admin / DataOps!2026)
 *   DSH_WAIT_MS=18000                     wait after the DSH frame appears
 *
 * Stable selectors (not copy-equality): the page root and the seat render the
 * `task-manager-page` / `task-manager-plaza-tab` / `task-manager-plaza-body`
 * test ids, and a contributed card carries `data-kb-workflow`. The tab's label
 * is asserted only as "contains 广场", so a locale change does not break this.
 */
import { chromium } from 'playwright'

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '')
const DSH_DIRECT = process.env.DSH_DIRECT === '1'
const SHOT_PATH = process.env.SHOT_PATH ?? '/root/projects/dsh-ui-shots/plaza-after.png'
const USER = process.env.DSH_USER ?? 'admin'
const PASS = process.env.DSH_PASS ?? 'DataOps!2026'
const WAIT_MS = Number(process.env.DSH_WAIT_MS ?? (DSH_DIRECT ? '12000' : '18000'))

const failures = []
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ' :: ' + detail}`)
  if (!ok) failures.push(label)
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', error => pageErrors.push(String(error).slice(0, 400)))

try {
  if (DSH_DIRECT) {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  } else {
    await page.goto(`${BASE_URL}/?test=true`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(12000)
    await page.locator('input').nth(0).fill(USER, { force: true })
    await page.locator('input[type=password]').fill(PASS, { force: true })
    await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
    await page.waitForTimeout(8000)
    await page.goto(`${BASE_URL}/ai/dsh`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  }
  await page.waitForTimeout(WAIT_MS)

  const frame = DSH_DIRECT
    ? page.mainFrame()
    : page.frames().find(candidate => candidate.url().includes('/dsh/'))
  if (frame === undefined) throw new Error('DSH frame not found; page frames: ' + page.frames().map(f => f.url()).join(', '))

  const clean = value => (value ?? '').trim().replace(/\s+/g, ' ')
  const clickNav = async () => {
    // The navigation label is the product copy; the page root test id is the stable anchor.
    const nav = frame.getByRole('button', { name: '自动化任务', exact: true })
    if (await nav.count() > 0) await nav.first().click({ force: true })
    await page.waitForTimeout(4000)
  }
  await clickNav()

  const pageRoot = frame.locator('[data-testid="task-manager-page"]')
  check(await pageRoot.count() === 1, 'automation task page renders', `count=${await pageRoot.count()}`)

  const plazaTab = frame.locator('[data-testid="task-manager-plaza-tab"]')
  const plazaTabCount = await plazaTab.count()
  check(plazaTabCount === 1, 'plaza tab exists', `count=${plazaTabCount}`)
  if (plazaTabCount === 1) {
    check(clean(await plazaTab.first().textContent()).includes('广场'), 'plaza tab label names the plaza', clean(await plazaTab.first().textContent()))
  }

  // The three status views each show rows or an explicit empty state.
  const views = {}
  for (const label of ['已开启', '已结束', '全部']) {
    const button = frame.getByRole('button', { name: label, exact: true }).first()
    await button.click({ force: true })
    await page.waitForTimeout(1200)
    views[label] = await frame.evaluate(() => ({
      rows: document.querySelectorAll('[class*=listRows] > li').length,
      empty: (document.querySelector('[class*=empty]')?.textContent ?? '').trim(),
      plazaBody: document.querySelector('[data-testid="task-manager-plaza-body"]') !== null,
      pressed: [...document.querySelectorAll('[class*=filterTab]')]
        .filter(element => element.getAttribute('aria-pressed') === 'true')
        .map(element => (element.textContent ?? '').trim()),
    }))
    const view = views[label]
    check(view.rows > 0 || view.empty !== '', `view ${label} shows rows or an explicit empty state`, JSON.stringify(view))
    check(view.plazaBody === false, `view ${label} is not the plaza body`)
  }

  // The plaza tab renders the contributed body and at least one workflow card.
  if (plazaTabCount === 1) {
    await plazaTab.first().click({ force: true })
    await page.waitForTimeout(2500)
    const plaza = await frame.evaluate(() => {
      const body = document.querySelector('[data-testid="task-manager-plaza-body"]')
      const box = body === null ? null : body.getBoundingClientRect()
      return {
        body: body !== null,
        size: box === null ? null : { width: Math.round(box.width), height: Math.round(box.height) },
        cards: [...document.querySelectorAll('[data-kb-workflow]')].map(element => element.getAttribute('data-kb-workflow')),
        kbTabs: [...document.querySelectorAll('[data-kb-plaza-tab]')].map(element => element.getAttribute('data-kb-plaza-tab')),
      }
    })
    console.log('PLAZA ' + JSON.stringify(plaza))
    check(plaza.body, 'plaza body renders')
    check(plaza.size !== null && plaza.size.width > 0 && plaza.size.height > 0, 'plaza body has non-zero size', JSON.stringify(plaza.size))
    check(plaza.cards.length > 0, 'plaza renders contributed workflow cards', JSON.stringify(plaza.cards))
    await page.screenshot({ path: SHOT_PATH })
    console.log('SHOT ' + SHOT_PATH)
  }

  // 新建 is an action, not a filter: click it last so the status checks above
  // still run against the page. A new Session shows a composer (contenteditable
  // or textarea) and the task-manager page leaves the main panel.
  const newButton = frame.getByRole('button', { name: '新建', exact: true }).first()
  if (await newButton.count() > 0) {
    await newButton.click({ force: true })
    await page.waitForTimeout(3000)
    const afterNew = await frame.evaluate(() => ({
      taskManager: document.querySelector('[data-testid="task-manager-page"]') !== null,
      composer: document.querySelectorAll('[contenteditable="true"], textarea').length,
    }))
    check(afterNew.taskManager === false || afterNew.composer > 0, '新建 opens a session composer', JSON.stringify(afterNew))
  } else {
    check(false, '新建 action exists')
  }

  check(pageErrors.length === 0, 'no page errors', JSON.stringify(pageErrors.slice(0, 5)))
  console.log(JSON.stringify({ ok: failures.length === 0, views, shot: SHOT_PATH, pageErrors, failures }, null, 1))
} catch (error) {
  failures.push('exception')
  console.error('EXCEPTION ' + (error instanceof Error ? error.stack ?? error.message : String(error)))
  console.log(JSON.stringify({ ok: false, failures, pageErrors }, null, 1))
} finally {
  await browser.close()
}

process.exit(failures.length === 0 ? 0 : 1)