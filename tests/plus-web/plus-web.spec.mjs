import { expect, test } from 'playwright/test'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { assertDiagnostics, watchDiagnostics } from './diagnostics.mjs'

const stateRoot = resolve(import.meta.dirname, '../../.cache/plus-web-system')
const pdfFixture = resolve(stateRoot, 'fixtures/acceptance.pdf')
const invalidBackup = resolve(stateRoot, 'fixtures/not-a-backup.zip')
const acceptanceWorkspace = resolve(stateRoot, 'workspace')

async function enterApp(page) {
  const launchURL = process.env.DSH_PLUS_TEST_START_URL
  if (launchURL === undefined) throw new Error('Plus Web launch URL was not prepared by global setup')
  await page.goto(launchURL)
  await page.locator('[class*="frame"]').waitFor({ timeout: 30_000 })
  const welcome = page.getByRole('dialog', { name: '内测声明' })
  const welcomeVisible = await welcome.waitFor({ timeout: 5_000 }).then(
    () => true,
    (error) => {
      if (error?.name !== 'TimeoutError') throw error
      return false
    },
  )
  if (welcomeVisible) {
    await welcome.getByRole('button', { name: '继续', exact: true }).click()
    await welcome.waitFor({ state: 'hidden', timeout: 15_000 })
  }
}

async function connectAcceptanceWorkspace(page) {
  const trigger = page.getByRole('textbox', { name: '选择工作区' })
  if (await trigger.isVisible()) {
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '选择工作区目录' })
    await dialog.getByRole('button', { name: '编辑路径' }).click()
    const path = dialog.getByRole('textbox', { name: '编辑路径' })
    await path.fill(acceptanceWorkspace)
    await path.press('Enter')
    await dialog.getByRole('button', { name: '打开', exact: true }).click()
  }
  await page.locator('[data-composer-input][contenteditable="true"]').waitFor({ timeout: 30_000 })
}

async function openSettings(page, section) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.waitFor({ timeout: 15_000 })
  await dialog.getByRole('button', { name: section, exact: true }).click()
  return dialog
}

async function selectAcceptanceModel(page) {
  const label = process.env.DSH_PLUS_TEST_MODEL_LABEL
  const trigger = page.getByRole('button', { name: /^(?:选择模型|Select model)/ })
  await expect(trigger).toBeVisible({ timeout: 30_000 })
  const current = await trigger.getAttribute('aria-label')
  if (current?.includes(label)) return
  await trigger.click()
  const menu = page.getByRole('menu', { name: /模型与推理等级|Model and reasoning effort/ })
  await menu.getByRole('menuitem', { name: /模型|Model/ }).click()
  await menu.getByRole('menuitemradio', { name: label, exact: true }).click()
  await expect(trigger).toContainText(label)
}

async function sendPrompt(page, prompt) {
  const input = page.getByRole('textbox').last()
  await input.fill(prompt)
  await page.getByRole('button', { name: /发送消息|Send message/ }).click()
}

test.beforeEach(async ({ page }) => {
  watchDiagnostics(page)
})

test.afterEach(async ({ page }, testInfo) => {
  try {
    await assertDiagnostics(page, testInfo)
  } finally {
    await rm(testInfo.outputPath('plus-backup.zip'), { force: true })
  }
})

test.describe('Plus npm profile user workflows', () => {
  test('persists the explicit OpenAI Responses gateway compatibility setting', async ({ page }) => {
    await enterApp(page)
    const dialog = await openSettings(page, '模型')
    const declare = dialog.getByRole('button', { name: '添加自定义提供方' })
    await expect(declare).toBeEnabled()
    await declare.click()
    await dialog.getByLabel('Provider ID').fill('plus-responses-gateway')
    await dialog.getByLabel('显示名称').fill('Plus Responses Gateway')
    await dialog.getByLabel('API 地址').fill('https://gateway.invalid/v1')
    await dialog.getByRole('button', { name: '添加模型' }).click()
    await dialog.getByLabel('模型 ID 1').fill('plus-responses-model')
    await dialog.getByRole('button', { name: '创建提供方', exact: true }).click()
    await dialog.getByText('Plus Responses Gateway', { exact: true }).first().waitFor()

    await dialog.getByRole('button', { name: '编辑 Plus Responses Gateway (plus-responses-gateway)' }).click()
    await dialog.getByText('自定义设置').click()
    const protocol = dialog.getByLabel('API 协议')
    await protocol.selectOption('openai-responses')
    const compatibility = dialog.getByLabel('中转站兼容模式')
    await expect(compatibility).toBeVisible()
    await compatibility.check()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByText(/已保存 Plus Responses Gateway/).waitFor()

    await dialog.getByRole('button', { name: '编辑 Plus Responses Gateway (plus-responses-gateway)' }).click()
    await dialog.getByText('自定义设置').click()
    await expect(dialog.getByLabel('API 协议')).toHaveValue('openai-responses')
    await expect(dialog.getByLabel('中转站兼容模式')).toBeChecked()
    await dialog.getByLabel('API 协议').selectOption('openai-completions')
    await expect(dialog.getByLabel('中转站兼容模式')).toHaveCount(0)
    await dialog.getByLabel('API 协议').selectOption('openai-responses')
    await expect(dialog.getByLabel('中转站兼容模式')).toBeChecked()
  })

  test('restores persisted Subagent settings through streamed Backup failure recovery and reload', async ({ page }, testInfo) => {
    await enterApp(page)
    let dialog = await openSettings(page, '子代理')
    const enabled = dialog.getByLabel('启用连续模式')
    await enabled.check()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled()

    await page.reload()
    dialog = await openSettings(page, '子代理')
    await expect(dialog.getByLabel('启用连续模式')).toBeChecked()
    await dialog.getByRole('button', { name: '备份', exact: true }).click()

    const downloadPromise = page.waitForEvent('download')
    await dialog.getByRole('button', { name: '导出备份压缩包', exact: true }).click()
    await expect(dialog.getByLabel('备份生成进度')).toBeVisible()
    const download = await downloadPromise
    const archive = testInfo.outputPath('plus-backup.zip')
    await download.saveAs(archive)
    await dialog.getByText('备份已生成，浏览器已开始下载。', { exact: true }).waitFor()

    await dialog.getByRole('button', { name: '子代理', exact: true }).click()
    await dialog.getByLabel('启用连续模式').uncheck()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: '备份', exact: true }).click()

    const input = dialog.locator('input[type="file"]')
    await input.setInputFiles(invalidBackup)
    await dialog.getByText('所选压缩包不是 DeepSeek Harness 备份文件。', { exact: true }).waitFor()
    await input.setInputFiles(archive)
    await expect(dialog.getByLabel('备份恢复进度')).toBeVisible()
    await dialog.getByText('备份已导入。重新加载页面后，会话和工作区将使用恢复后的数据。', { exact: true }).waitFor({ timeout: 6 * 60_000 })
    await dialog.getByRole('button', { name: '重新加载页面', exact: true }).click()

    dialog = await openSettings(page, '子代理')
    await expect(dialog.getByLabel('启用连续模式')).toBeChecked()
  })

  test('submits a real document and preserves its cards in Chat and Trajectory', async ({ page }) => {
    await enterApp(page)
    await connectAcceptanceWorkspace(page)
    await selectAcceptanceModel(page)
    const chooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '添加文件', exact: true }).click()
    await (await chooserPromise).setFiles(pdfFixture)
    const drafts = page.getByLabel('待发送文档')
    await expect(drafts.getByText('acceptance.pdf', { exact: true })).toBeVisible()
    await sendPrompt(page, 'Read the attached document and reply with exactly DOCUMENT_OK.')
    const history = page.getByLabel('已附加文档').first()
    await expect(history.getByText('acceptance.pdf', { exact: true })).toBeVisible({ timeout: 3 * 60_000 })
    await page.getByText('DOCUMENT_OK', { exact: true }).waitFor({ timeout: 6 * 60_000 })

    await page.getByRole('tab', { name: /轨迹|Trajectory/ }).click()
    await page.getByRole('row', { name: /用户.*Read the attached document/ }).click()
    await expect(page.getByLabel('已附加文档').getByText('acceptance.pdf', { exact: true }).first()).toBeVisible()
    await page.getByRole('tab', { name: /对话|Chat/ }).click()
  })

  test('authorizes DataOps through its real UI and renders an inspectable chart from a tool result', async ({ page }, testInfo) => {
    await enterApp(page)
    await connectAcceptanceWorkspace(page)
    const dialog = await openSettings(page, 'DataOps')
    const connected = dialog.getByText('已连接', { exact: true })
    const notConnected = dialog.getByText('未连接', { exact: true })
    await expect(connected.or(notConnected)).toBeVisible()
    if (await notConnected.isVisible()) {
      const popupPromise = page.waitForEvent('popup')
      await dialog.getByRole('button', { name: '连接 DataOps', exact: true }).click()
      const popup = await popupPromise
      watchDiagnostics(popup)
      const authorize = popup.getByRole('button', { name: /授权并返回|Authorize and return/ })
      const loginRequired = popup.getByRole('button', { name: /PKI登录|PKI login/ })
      await expect(authorize.or(loginRequired)).toBeVisible({ timeout: 60_000 })
      if (await loginRequired.isVisible()) {
        await assertDiagnostics(popup, testInfo)
        throw new Error('DataOps authorization requires an authenticated account in the real DataOps Web UI')
      }
      await authorize.click()
      await popup.waitForEvent('close', { timeout: 60_000 })
      await assertDiagnostics(popup, testInfo)
    }
    await connected.waitFor({ timeout: 60_000 })
    await page.reload()
    await page.getByRole('button', { name: /新建会话|New session/ }).first().click()
    await selectAcceptanceModel(page)
    await sendPrompt(page, '请列出我有权访问的 DataOps 资源，按资源类型统计数量，并展示柱状图。')
    const chart = page.getByLabel(/交互式数据图表|Interactive data chart/)
    await chart.waitFor({ timeout: 8 * 60_000 })
    await page.locator('section[data-tool="render_chart"]').getByRole('button', { name: /检查|Inspect/ }).click()
    await expect(page.getByRole('complementary', { name: /事件详情|Event details/ })).toBeVisible()
  })

  test('uses the external sidebar and plugin market then folds real Trajectory turns', async ({ page }) => {
    await enterApp(page)
    await connectAcceptanceWorkspace(page)
    const collapse = page.getByRole('button', { name: /收起侧边栏|Collapse sidebar/ })
    await collapse.click()
    const expand = page.getByRole('button', { name: /打开侧边栏|Open sidebar/ })
    await expand.click()
    const market = await openSettings(page, '插件市场')
    await market.getByText('发现社区为 DeepSeek Harness 开发的插件', { exact: true }).waitFor()
    await page.reload()

    await page.getByRole('button', { name: /新建会话|New session/ }).first().click()
    await selectAcceptanceModel(page)
    await sendPrompt(page, 'Reply with exactly TURN_ONE.')
    await page.getByText('TURN_ONE', { exact: true }).waitFor({ timeout: 6 * 60_000 })
    await sendPrompt(page, 'Reply with exactly TURN_TWO.')
    await page.getByText('TURN_TWO', { exact: true }).waitFor({ timeout: 6 * 60_000 })
    await page.getByRole('tab', { name: /轨迹|Trajectory/ }).click()
    await page.getByRole('button', { name: /收起所有轮次|Collapse turns/ }).click({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: /展开所有轮次|Expand turns/ })).toBeVisible()
  })
})

test.describe('Plus mobile Web navigation', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('opens the real mobile sidebar and returns to the composer without overlap', async ({ page }) => {
    await enterApp(page)
    await connectAcceptanceWorkspace(page)
    await page.getByRole('button', { name: /打开侧边栏|Open sidebar/ }).click()
    await page.getByRole('button', { name: /新建会话|New session/ }).first().click()
    const composer = page.getByRole('textbox').last()
    await expect(composer).toBeVisible()
    await expect(page.getByRole('button', { name: /发送消息|Send message/ })).toBeVisible()
  })
})
