/**
 * Original-knowledge-base regression pass for the 0.1.25 release.
 *
 * The graph work must not change the existing KB surface. This script clicks the
 * folder tree, the filter, the sort menu, New, a document preview and Share, and
 * fails on any uncaught page error.
 *
 * Run: node tests/kg-kb-regression.mjs
 */
import { chromium } from 'playwright'

const SHOTS = '/root/projects/dsh-ui-shots'
const results = []
const pageErrors = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)))
  if (!ok) process.exitCode = 1
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
const page = await context.newPage()
page.on('pageerror', error => pageErrors.push(String(error)))

try {
  await page.goto('http://127.0.0.1:3000/?test=true', { waitUntil: 'domcontentloaded', timeout: 40000 })
  await page.waitForTimeout(12000)
  await page.locator('input').nth(0).fill('admin', { force: true })
  await page.locator('input[type=password]').fill('DataOps!2026', { force: true })
  await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
  await page.waitForTimeout(8000)
  await page.goto('http://127.0.0.1:3000/ai/dsh', { waitUntil: 'domcontentloaded', timeout: 40000 })
  await page.waitForTimeout(18000)
  const frame = page.frames().find(candidate => candidate.url().includes(':32000') && !candidate.url().includes('/knowledge-base/'))
  if (frame === undefined) throw new Error('DSH frame not found')
  await frame.locator('button').filter({ hasText: /^知识库$/u }).first().click()
  await page.waitForTimeout(2500)

  // 1. Folder tree.
  const folder = frame.locator('span').filter({ hasText: /^制度$/u }).first()
  check('folder tree renders the 制度 folder', await folder.isVisible())
  await folder.click()
  await page.waitForTimeout(500)
  check('folder tree row is still there after clicking it', await folder.isVisible())

  // 2. Search / in-place filter.
  await frame.getByRole('button', { name: '筛选当前目录' }).click()
  const filter = frame.getByPlaceholder('按文件名筛选…')
  await filter.fill('制度')
  await page.waitForTimeout(500)
  check('search narrows the file tree', await frame.getByText('制度', { exact: true }).first().isVisible()
    && await frame.getByText('项目材料', { exact: true }).count() === 0)
  await filter.fill('')
  await frame.getByRole('button', { name: '筛选当前目录' }).click()
  await page.waitForTimeout(300)

  // 3. Sort menu.
  await frame.getByRole('button', { name: '排序与过滤' }).click()
  await page.waitForTimeout(300)
  check('sort menu opens', await frame.getByText('按文件名', { exact: true }).first().isVisible())
  await frame.getByText('按文件名', { exact: true }).first().click()
  await page.waitForTimeout(400)
  check('sort menu closes after choosing an order', await frame.getByText('按文件名', { exact: true }).count() === 0)

  // 4. New.
  await frame.locator('button').filter({ hasText: /^设置$/u }).first().click()
  await page.waitForTimeout(500)
  await frame.getByRole('button', { name: '新建知识文档' }).click()
  await page.waitForTimeout(700)
  check('New returns to Home', await frame.locator('h2').filter({ hasText: /^主页$/u }).first().isVisible())

  // 5. Preview. The host right column has no session surface on a global panel,
  // so the page's own permission-checked preview is the visible surface.
  const previewRow = frame.locator('[class*=explorerRow]').filter({ hasText: 'checkRule.sh' }).first()
  await previewRow.click()
  await page.waitForTimeout(300)
  await previewRow.dblclick()
  await page.waitForTimeout(2500)
  const preview = frame.locator('[data-testid=kg-file-preview]')
  const previewCount = await preview.count()
  const previewText = await preview.innerText().catch(() => '')
  const pageText = await frame.evaluate(() => document.body.innerText)
  check('document preview renders in the page', previewCount === 1
    && previewText.includes('checkRule.sh')
    && !pageText.includes('已在右侧文件窗口中打开'),
    { previewCount, previewText: previewText.slice(0, 160), tail: pageText.slice(-300) })
  check('KB tree contains no graph rows', !(await frame.evaluate(() => document.body.innerText)).includes('知识图谱/平台建设'))

  // 6. Share.
  const shareRow = frame.locator('span').filter({ hasText: /^制度$/u }).first()
  const box = await shareRow.boundingBox()
  if (box === null) throw new Error('no share row box')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  const share = frame.getByText('分享', { exact: true }).last()
  await share.waitFor({ state: 'visible', timeout: 5000 })
  await share.click()
  const dialog = frame.locator('[role=dialog][aria-label=分享]')
  await dialog.waitFor({ state: 'visible', timeout: 5000 })
  check('Share dialog opens', await dialog.isVisible())
  await page.screenshot({ path: SHOTS + "/kg-kb-regression.png" })
  await frame.getByRole('button', { name: '取消' }).last().click()
  await page.waitForTimeout(400)
  check('Share dialog closes', await dialog.count() === 0)

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3))
  console.log('\nRESULT ' + JSON.stringify({ passed: results.filter(item => item.ok).length, failed: results.filter(item => !item.ok).length }))
} catch (error) {
  check('KB regression script completed', false, String(error))
  await page.screenshot({ path: SHOTS + '/kg-kb-regression-failure.png' }).catch(() => {})
} finally {
  await browser.close()
}