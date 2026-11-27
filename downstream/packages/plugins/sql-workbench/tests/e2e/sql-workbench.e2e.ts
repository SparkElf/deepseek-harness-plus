import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const PAGE_URL = process.env.DSH_E2E_URL
if (PAGE_URL === undefined) throw new Error('DSH_E2E_URL must point to a running DSH Web GUI with both plugins installed')
const DATABASE_FILE = process.env.DSH_SQL_E2E_DB ?? join(homedir(), '.dsh', 'sql-workbench-system.sqlite')
const CONNECTION_NAME = 'SQL Workbench E2E'
const TABLE_NAME = 'dsh_sql_workbench_e2e'

async function dismissOnboarding(page: Page): Promise<void> {
  for (const name of ['Continue', 'Configure later']) {
    const button = page.getByRole('button', { name, exact: true }).first()
    if (await button.count()) await button.click()
  }
}

async function createTestSession(page: Page) {
  const newSession = page.getByRole('button', { name: /New session|新建会话/i, exact: true }).last()
  await newSession.click()
  const composer = page.locator('#root [contenteditable="true"]').last()
  await composer.fill('这是 SQL 工作台系统测试会话，只回复 OK。')
  await page.getByRole('button', { name: /发送|Send/i }).last().click()
  await expect(page.locator('[role="treeitem"][aria-selected="true"]')).not.toContainText('New Session')
  await expect(page.getByText('OK', { exact: true }).last()).toBeVisible({ timeout: 120_000 })
  return composer
}

async function setSql(page: Page, sql: string): Promise<void> {
  const editor = page.locator('[data-dsh-sql-workbench] .cm-content').first()
  await editor.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type(sql)
}

async function runSql(page: Page, sql: string): Promise<void> {
  await setSql(page, sql)
  const completed = page.waitForResponse(response => response.url().includes('/dsh-sql-workbench/api/query.run'))
  await page.getByTitle('执行查询').click()
  await completed
  await expect(page.locator('[data-sql-result-grid]')).toBeVisible()
}

test('user manages SQL, saves it, and adds query and table references to chat', async ({ page }) => {
  const pageErrors: Error[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', error => { pageErrors.push(error) })
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('requestfailed', request => { consoleErrors.push('request failed: ' + request.url()) })
  page.on('response', response => {
    if (response.url().includes('/dsh-sql-workbench/') && response.status() >= 400) {
      consoleErrors.push('HTTP ' + response.status() + ': ' + response.url())
    }
  })

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await dismissOnboarding(page)
  const composer = await createTestSession(page)

  const sidebar = page.locator('[data-rightbar-col]')
  await page.locator('[data-sidebar-right-expand]').click()
  const guide = sidebar.locator('[data-sidebar-right-guide]')
  await expect(guide).toBeVisible()
  await guide.getByRole('button', { name: /Database|数据库/ }).click()

  const workbench = page.locator('[data-dsh-sql-workbench]')
  await expect(workbench).toBeVisible()
  const connectionSelect = workbench.getByRole('button', { name: '数据库连接' })
  await connectionSelect.click()
  const existing = page.getByRole('option', { name: new RegExp(CONNECTION_NAME) })
  if ((await existing.count()) === 0) {
    await workbench.getByTitle('新建连接').click()
    const dialog = page.getByRole('dialog', { name: '数据库连接' })
    await dialog.getByLabel('名称').fill(CONNECTION_NAME)
    await dialog.getByLabel('类型').selectOption('sqlite')
    await dialog.getByLabel('数据库文件').fill(DATABASE_FILE)
    await dialog.getByRole('button', { name: '测试连接' }).click()
    await expect(dialog.getByText('连接成功')).toBeVisible()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
  } else {
    await existing.click()
  }

  await workbench.getByTitle('新建查询').first().click()
  await runSql(page, 'CREATE TABLE IF NOT EXISTS ' + TABLE_NAME + ' (id INTEGER PRIMARY KEY, name TEXT)')
  await runSql(page, 'DELETE FROM ' + TABLE_NAME)
  await runSql(page, "WITH RECURSIVE seq(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM seq WHERE id < 120) INSERT INTO " + TABLE_NAME + " (id, name) SELECT id, 'Navicat workflow ' || id FROM seq")
  await runSql(page, 'SELECT id, name FROM ' + TABLE_NAME)
  await expect(workbench.locator('[data-sql-result-grid]')).toContainText('Navicat workflow 1')

  await workbench.getByTitle('保存查询').click()
  const saveDialog = page.getByRole('dialog', { name: '保存查询' })
  await saveDialog.getByLabel('查询名称').fill('E2E saved query')
  await saveDialog.getByRole('button', { name: '保存', exact: true }).click()

  await workbench.locator('[data-sql-explorer-tabs]').getByRole('button', { name: '查询', exact: true }).click()
  const queryRow = workbench.getByRole('button', { name: /E2E saved query/ }).first()
  await queryRow.click({ button: 'right' })
  await page.getByRole('button', { name: '添加查询到对话' }).click()
  await expect(composer).toContainText('E2E saved query')

  await workbench.locator('[data-sql-explorer-tabs]').getByRole('button', { name: '对象', exact: true }).click()
  await workbench.getByTitle('刷新对象').click()
  const databaseRow = workbench.locator('[data-sql-object-tree] > div > button').first()
  await expect(databaseRow).toBeVisible()
  await databaseRow.click()
  const tableRow = workbench.locator('[data-sql-object-tree] button', { hasText: TABLE_NAME }).first()
  await expect(tableRow).toBeVisible()
  await tableRow.click()
  await expect(workbench.locator('[data-sql-object-details]')).toContainText(TABLE_NAME)
  await expect(workbench.locator('[data-sql-object-details]')).toContainText('id')

  const previewCompleted = page.waitForResponse(response => response.url().includes('/dsh-sql-workbench/api/object.preview'))
  await tableRow.dblclick()
  await previewCompleted
  const previewGrid = workbench.locator('[data-sql-result-grid]')
  await expect(previewGrid).toBeVisible()
  await expect(previewGrid.locator('thead input')).toHaveCount(2)
  await expect(previewGrid).toContainText(/共 120 行|120 total rows/)

  const sortCompleted = page.waitForResponse(response => response.url().includes('/dsh-sql-workbench/api/object.preview'))
  await previewGrid.getByRole('button', { name: /id/ }).click()
  await sortCompleted
  await expect(previewGrid.locator('tbody tr').first()).toContainText('120')

  const filterCompleted = page.waitForResponse(response => response.url().includes('/dsh-sql-workbench/api/object.preview'))
  await previewGrid.locator('thead input').nth(1).fill('workflow 10')
  await previewGrid.locator('thead input').nth(1).press('Enter')
  await filterCompleted
  await expect(previewGrid).toContainText(/共 11 行|11 total rows/)

  await workbench.getByRole('button', { name: '对象', exact: true }).first().click()
  await tableRow.click({ button: 'right' })
  await page.getByRole('button', { name: '添加到对话', exact: true }).click()
  await expect(composer).toContainText(TABLE_NAME)

  await composer.fill('请调用 sql_update_current_query，把当前查询完整替换为 SELECT id, name FROM ' + TABLE_NAME + ' WHERE id = 1; 不要创建新查询。')
  await page.getByRole('button', { name: /发送|Send/i }).last().click()
  const editor = workbench.locator('.cm-content').first()
  await expect(editor).toContainText('WHERE id = 1', { timeout: 120_000 })
  await composer.fill('继续修改当前查询，在原 SQL 末尾加入 ORDER BY name，不要创建新查询。')
  await page.getByRole('button', { name: /发送|Send/i }).last().click()
  await expect(editor).toContainText('ORDER BY name', { timeout: 120_000 })
  await composer.fill('')

  await workbench.locator('[data-sql-explorer-tabs]').getByRole('button', { name: '查询', exact: true }).click()
  const savedRow = workbench.getByRole('button', { name: /E2E saved query/ }).last()
  await savedRow.click({ button: 'right' })
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await runSql(page, 'DROP TABLE ' + TABLE_NAME)
  await workbench.getByTitle('关闭查询').last().click()
  await workbench.getByTitle('删除连接').click()

  expect(pageErrors).toEqual([])
  expect(consoleErrors.filter(message => message.includes('dsh-sql-workbench'))).toEqual([])
})
