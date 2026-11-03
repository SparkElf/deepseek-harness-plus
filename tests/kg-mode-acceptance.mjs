/**
 * Knowledge-base 图谱 mode acceptance (read-only loop).
 *
 * Real interaction only: log in through the DataOps gateway, open the knowledge
 * panel, switch the two scope pills, inspect the permission-filtered graph tree,
 * render the canvas iframe, open a topic detail, then switch back and exercise the
 * original KB tree controls.
 *
 * Run: node tests/kg-mode-acceptance.mjs
 */
import { chromium } from 'playwright'

const SHOTS = '/root/projects/dsh-ui-shots'
const results = []
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
const pageErrors = []
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

  // ---------------------------------------------------------------- KB baseline
  await frame.locator('button').filter({ hasText: /^知识库$/u }).first().click()
  await page.waitForTimeout(2500)
  check('KB tree renders before the graph tab', await frame.getByText('制度', { exact: true }).first().isVisible())

  // The filter is the state whose survival proves the tab switch did not reload
  // the page or remount the panel.
  await frame.getByRole('button', { name: '筛选当前目录' }).click()
  const filter = frame.getByPlaceholder('按文件名筛选…')
  await filter.fill('制度')
  await page.waitForTimeout(600)
  check('KB filter narrows the tree', await frame.getByText('制度', { exact: true }).first().isVisible()
    && await frame.getByText('项目材料', { exact: true }).count() === 0)

  // Sort menu opens and offers the order rows.
  await frame.getByRole('button', { name: '排序与过滤' }).click()
  await page.waitForTimeout(400)
  check('KB sort menu opens', await frame.getByText('按文件名', { exact: true }).first().isVisible())
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // New button navigates to Home (this plugin's create surface is a navigation,
  // not a create route). Returning to 设置 first makes the assertion meaningful.
  await frame.locator('button').filter({ hasText: /^设置$/u }).first().click()
  await page.waitForTimeout(600)
  await frame.getByRole('button', { name: '新建知识文档' }).click()
  await page.waitForTimeout(700)
  check('KB new button lands on Home', await frame.locator('h2').filter({ hasText: /^主页$/u }).first().isVisible())

  // ------------------------------------------------------- tab switch, no reload
  const before = await frame.evaluate(() => {
    window.__kgMarker = 'kept-across-scope-switch'
    return {
      href: location.href,
      navigationCount: performance.getEntriesByType('navigation').length,
      timeOrigin: performance.timeOrigin,
      selectedTab: [...document.querySelectorAll('[role=tab]')].map(tab => ({
        text: (tab.textContent || '').trim(),
        selected: tab.getAttribute('aria-selected'),
      })),
    }
  })
  check('KB tab is selected before switching', before.selectedTab.some(tab => tab.text === '知识库' && tab.selected === 'true'), before.selectedTab)

  await frame.getByRole('tab', { name: '图谱', exact: true }).click()
  await page.waitForTimeout(3500)

  const after = await frame.evaluate(() => ({
    href: location.href,
    navigationCount: performance.getEntriesByType('navigation').length,
    timeOrigin: performance.timeOrigin,
    marker: window.__kgMarker,
    selectedTab: [...document.querySelectorAll('[role=tab]')].map(tab => ({
      text: (tab.textContent || '').trim(),
      selected: tab.getAttribute('aria-selected'),
    })),
    filterValue: document.querySelector('input[placeholder="按文件名筛选…"]')?.value ?? null,
  }))
  check('tab switch did not reload the page', after.href === before.href
    && after.navigationCount === before.navigationCount
    && after.timeOrigin === before.timeOrigin
    && after.marker === 'kept-across-scope-switch', { before, after })
  check('graph tab is selected and KB tab is not', after.selectedTab.some(tab => tab.text === '图谱' && tab.selected === 'true')
    && after.selectedTab.some(tab => tab.text === '知识库' && tab.selected === 'false'))
  check('graph tab starts with its own empty filter', after.filterValue === '', after.filterValue)

  // ------------------------------------------------- permission-filtered graph tree
  const tree = await frame.evaluate(async () => {
    const response = await fetch('/knowledge-base/api/graph', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    return { status: response.status, body: await response.text() }
  })
  const payload = JSON.parse(tree.body)
  const graphs = payload.scopes.flatMap(scope => scope.groups.flatMap(group => group.graphs))
  const names = graphs.map(graph => graph.name)
  check('graph API is authorized and returns the domain tree', tree.status === 200
    && payload.scopes.map(scope => scope.key).join(',') === 'global,department,personal', {
    status: tree.status, graphs: names, scanned: payload.scanned, visible: payload.visible, denied: payload.denied,
  })
  check('only the caller scopes are scanned', payload.scanned === 3 && payload.visible === 3 && payload.denied === 0,
    { scanned: payload.scanned, visible: payload.visible, denied: payload.denied })
  check('the three readable graphs are present', ['平台建设', '数据平台', '工作轨迹'].every(name => names.includes(name)), names)
  check('foreign personal/department graphs are absent', ['别人的图谱', '外部门图谱'].every(name => !names.includes(name))
    && !tree.body.includes('私密主题') && !tree.body.includes('外部主题'))

  const treePanel = frame.locator('[data-testid=kg-tree]')
  check('graph tree has the three top-level folders', await treePanel.count() === 1
    && await frame.locator('[data-testid=kg-scope]').count() === 3, {
    scopes: await frame.locator('[data-testid=kg-scope-row]').allTextContents(),
  })
  check('all three scope folders start collapsed',
    await frame.locator('[data-testid=kg-scope-row][aria-expanded=false]').count() === 3,
    await frame.locator('[data-testid=kg-scope-row]').allTextContents())
  await frame.locator('[data-testid=kg-scope][data-scope=global] [data-testid=kg-scope-row]').click()
  await page.waitForTimeout(400)
  await frame.locator('[data-testid=kg-graph]').filter({ hasText: '平台建设' }).click()
  await page.waitForTimeout(500)
  check('active graph is a file row and expands its topics',
    await frame.locator('[data-testid=kg-graph]').count() === 1
    && await frame.locator('[data-testid=kg-topic]').count() === 4,
    { graphs: await frame.locator('[data-testid=kg-graph]').allTextContents(), topics: await frame.locator('[data-testid=kg-topic]').allTextContents() })
  await page.screenshot({ path: SHOTS + '/kg-tree-filetree.png' })
  check('graph header states the counts', await frame.getByText('4 条线').first().isVisible()
    && await frame.getByText('3 篇关系').first().isVisible()
    && await frame.getByText('6 篇文档').first().isVisible())

  // ------------------------------------------------------------ canvas rendering
  const canvasFrame = () => page.frames().find(candidate => candidate.url().includes('/knowledge-base/api/graph.canvas'))
  await frame.locator('[data-testid=kg-canvas-frame]').waitFor({ state: 'attached', timeout: 10000 })
  let canvas = canvasFrame()
  for (let i = 0; i < 40 && (canvas === undefined || await canvas.locator('.card').count() === 0); i += 1) {
    await page.waitForTimeout(250)
    canvas = canvasFrame()
  }
  check('canvas iframe renders cards', canvas !== undefined && await canvas.locator('.card').count() === 4,
    canvas === undefined ? 'no canvas frame' : await canvas.locator('.card h3').allTextContents())
  check('canvas renders relation pills', canvas !== undefined && await canvas.locator('.pill').count() === 3,
    canvas === undefined ? 0 : await canvas.locator('.pill').count())
  check('first entry is at 100% zoom', canvas !== undefined
    && (await canvas.locator('#zoomLabel').textContent()).trim() === '100%',
    canvas === undefined ? 'no canvas' : await canvas.locator('#zoomLabel').textContent())
  await page.screenshot({ path: SHOTS + '/kg-zoom-initial.png' })
  if (canvas !== undefined) {
    await canvas.locator('#zin').click()
    await page.waitForTimeout(300)
    const zoomed = (await canvas.locator('#zoomLabel').textContent()).trim()
    await canvas.locator('#zoomLabel').click()
    await page.waitForTimeout(400)
    const reset = (await canvas.locator('#zoomLabel').textContent()).trim()
    check('percentage control resets to 100%', zoomed !== '100%' && reset === '100%', { zoomed, reset })
  }
  await page.screenshot({ path: SHOTS + '/kg-graph.png' })

  // ---------------------------------------------------------------- topic detail
  if (canvas !== undefined) {
    await canvas.locator('.card', { hasText: '任务总线' }).first().click()
    await page.waitForTimeout(700)
    check('clicking a canvas card opens its detail panel', await canvas.locator('#panel.open').count() === 1
      && (await canvas.locator('#p-title').textContent()) === '任务总线', {
      title: await canvas.locator('#p-title').textContent(),
      body: (await canvas.locator('#p-body').innerText()).slice(0, 80),
    })
    check('detail panel lists documents and relations', (await canvas.locator('.p-doc-item').count()) === 2
      && (await canvas.locator('.rel').count()) === 2)
    await page.screenshot({ path: SHOTS + '/kg-canvas-detail.png' })
  }

  // ------------------------------------------------------------- graph switching
  await frame.locator('[data-testid=kg-scope][data-scope=personal]').locator('[data-testid=kg-scope-row]').click()
  await page.waitForTimeout(400)
  await frame.locator('[data-testid=kg-graph]').filter({ hasText: '工作轨迹' }).click()
  await page.waitForTimeout(1500)
  canvas = canvasFrame()
  check('rail switches the canvas to another graph', canvas !== undefined
    && await canvas.locator('.card').count() === 2, canvas === undefined ? 'no canvas frame' : await canvas.locator('.card h3').allTextContents())
  check('graph switch closes the previous detail panel', canvas !== undefined && await canvas.locator('#panel.open').count() === 0)
  check('graph switch returns to 100% zoom', canvas !== undefined
    && (await canvas.locator('#zoomLabel').textContent()).trim() === '100%',
    canvas === undefined ? 'no canvas' : await canvas.locator('#zoomLabel').textContent())
  await page.screenshot({ path: SHOTS + '/kg-zoom-after-switch.png' })
  if (canvas !== undefined) {
    await canvas.locator('.card', { hasText: '个人知识库' }).first().click()
    await page.waitForTimeout(600)
    check('topic detail works in the second graph', (await canvas.locator('#p-title').textContent()) === '个人知识库')
  }
  await frame.locator('[data-testid=kg-graph]').filter({ hasText: '平台建设' }).click()
  await page.waitForTimeout(1200)

  // -------------------------------------------------------------- back to the KB
  await frame.getByRole('tab', { name: '知识库', exact: true }).click()
  await page.waitForTimeout(1200)
  check('KB tab returns to the folder tree', await frame.locator('[data-testid=kg-canvas-frame]').count() === 0
    && await frame.getByText('制度', { exact: true }).first().isVisible())
  const kbText = await frame.evaluate(() => document.body.innerText)
  check('KB tree contains no graph rows', !kbText.includes('部门/数据平台/知识图谱') && !kbText.includes('知识图谱/平台建设'))
  const filterAfter = frame.getByPlaceholder('按文件名筛选…')
  check('KB filter value survived the round trip', await filterAfter.inputValue() === '制度', await filterAfter.inputValue())
  check('KB tree is still filtered after returning', await frame.getByText('制度', { exact: true }).first().isVisible()
    && await frame.getByText('项目材料', { exact: true }).count() === 0)

  // Clearing the filter brings the other folders back, so the filter is live and
  // not merely a preserved string.
  await filterAfter.fill('')
  await page.waitForTimeout(600)
  check('clearing the KB filter restores the tree', await frame.getByText('项目材料', { exact: true }).first().isVisible())
  await frame.getByRole('button', { name: '筛选当前目录' }).click()
  await page.waitForTimeout(300)
  await frame.getByRole('button', { name: '排序与过滤' }).click()
  await page.waitForTimeout(300)
  check('KB sort menu still works after returning', await frame.getByText('按文件名', { exact: true }).first().isVisible())
  await page.keyboard.press('Escape')
  await frame.getByRole('button', { name: '新建知识文档' }).click()
  await page.waitForTimeout(500)
  check('KB new button still works after returning', await frame.locator('h2').filter({ hasText: /^主页$/u }).first().isVisible())
  await page.screenshot({ path: SHOTS + '/kg-kb-back.png' })

  // A close-up of the pills as shipped.
  const band = frame.locator('[role=tablist]').first()
  if (await band.count() > 0) {
    await band.screenshot({ path: SHOTS + '/kg-tabs.png' }).catch(() => {})
  }

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3))
} catch (error) {
  check('acceptance script completed', false, String(error))
} finally {
  console.log('\nRESULT ' + JSON.stringify({ passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }))
  await page.screenshot({ path: SHOTS + '/kg-final.png' }).catch(() => {})
  await browser.close()
}