import { expect, test } from 'playwright/test'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { allowNextNavigationAbort, assertDiagnostics, watchDiagnostics } from './diagnostics.mjs'

const stateRoot = resolve(import.meta.dirname, '../../.cache/plus-web-system')
const pdfFixture = resolve(stateRoot, 'fixtures/acceptance.pdf')
const invalidBackup = resolve(stateRoot, 'fixtures/not-a-backup.zip')
const acceptanceWorkspace = resolve(stateRoot, 'workspace')
const backupWorkspace = resolve(stateRoot, 'workspace-after-backup')

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

async function addWorkspace(page, directory) {
  await page.getByRole('button', { name: '添加工作区', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '选择工作区目录' })
  await dialog.getByRole('button', { name: '编辑路径' }).click()
  const path = dialog.getByRole('textbox', { name: '编辑路径' })
  await path.fill(directory)
  await path.press('Enter')
  await dialog.getByRole('button', { name: '打开', exact: true }).click()
  await expect(page.getByRole('treeitem', { name: 'workspace-after-backup', exact: true })).toBeVisible()
}

async function selectAcceptanceModel(page, reasoningEffort) {
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
  if (reasoningEffort === undefined) return
  await trigger.click()
  const effortMenu = page.getByRole('menu', { name: /模型与推理等级|Model and reasoning effort/ })
  await effortMenu.getByRole('menuitem', { name: /推理等级|Effort/ }).click()
  await effortMenu.getByRole('menuitemradio', { name: reasoningEffort, exact: true }).click()
  await expect(trigger).toContainText(reasoningEffort)
}

async function sendPrompt(page, prompt) {
  const input = page.getByRole('textbox').last()
  await input.fill(prompt)
  await page.getByRole('button', { name: /发送消息|Send message/ }).click()
}

async function answerFirstClarification(page) {
  const submit = page.getByRole('button', { name: /^(提交|Submit)$/ })
  const choice = page.getByRole('radio').or(page.getByRole('checkbox')).first()
  if (await choice.isVisible()) {
    await choice.click()
  } else {
    const freeText = page.getByRole('textbox').last()
    await expect(freeText).toBeVisible({ timeout: 30_000 })
    await freeText.fill('请根据当前可用数据自行选择并继续。')
  }
  await submit.click()
  await submit.waitFor({ state: 'hidden', timeout: 30_000 })
}

async function projectedToolStates(page) {
  return page.locator('[data-tool]').evaluateAll(elements => (
    [...new Set(elements.map((element) => {
      const name = element.getAttribute('data-tool')
      if (name === null) return null
      const state = element.getAttribute('data-state')
      return state === null ? name : `${name}:${state}`
    }).filter(Boolean))]
  ))
}


test.beforeEach(async ({ page }) => {
  watchDiagnostics(page)
})

test.afterEach(async ({ page }, testInfo) => {
  try {
    await assertDiagnostics(page, testInfo)
  } finally {
    await Promise.all([
      'configuration-backup.zip',
      'sessions-backup.zip',
      'all-backup.zip',
    ].map(file => rm(testInfo.outputPath(file), { force: true })))
  }
})

test.describe('Plus npm profile user workflows', () => {
  test('uses the official client brand instead of the local-build fallback', async ({ page }) => {
    await enterApp(page)
    await expect(page).toHaveTitle('DeepSeek Harness')
    await expect(page.getByText('DSH 本地构建', { exact: true })).toHaveCount(0)
  })

  test('places Simplified-Chinese Session export beside Trajectory search and downloads', async ({ page }) => {
    await enterApp(page)
    await connectAcceptanceWorkspace(page)
    await sendPrompt(page, '/goal clear')
    const trajectoryTab = page.getByRole('tab', { name: /轨迹|Trajectory/ })
    await trajectoryTab.waitFor({ timeout: 30_000 })
    await trajectoryTab.click()
    const toolbar = page.getByRole('toolbar', { name: '轨迹工具栏', exact: true })
    const action = toolbar.getByRole('button', { name: '会话日志', exact: true })
    const utilities = toolbar.locator('[data-trajectory-toolbar-utilities]')
    const search = toolbar.locator('[data-trajectory-search]')
    await expect(action).toBeVisible()
    await expect(page.getByText('Session 日志', { exact: true })).toHaveCount(0)
    const [actionBox, utilitiesBox, searchBox] = await Promise.all([
      action.boundingBox(),
      utilities.boundingBox(),
      search.boundingBox(),
    ])
    if (actionBox === null || utilitiesBox === null || searchBox === null) {
      throw new Error('Trajectory export and search controls must be visible for layout acceptance')
    }
    expect(Math.abs(
      (actionBox.y + actionBox.height / 2) - (searchBox.y + searchBox.height / 2),
    )).toBeLessThanOrEqual(1)
    expect(searchBox.x).toBeGreaterThanOrEqual(utilitiesBox.x + utilitiesBox.width)
    expect(searchBox.x - (utilitiesBox.x + utilitiesBox.width)).toBeLessThanOrEqual(9)

    const downloadPromise = page.waitForEvent('download')
    await action.click()
    await downloadPromise
    const dialog = page.getByRole('dialog', { name: '会话导出已开始下载' })
    await expect(dialog).toContainText('浏览器正在下载会话 ZIP 文件。')
    await dialog.getByText('关闭', { exact: true }).click()
    await expect(dialog).toBeHidden()
  })

  test('places the attachment picker directly beside the command button', async ({ page }) => {
    await enterApp(page)
    await connectAcceptanceWorkspace(page)
    const command = page.getByRole('button', { name: '指令', exact: true })
    const picker = page.getByRole('button', { name: '添加文件', exact: true })
    const [commandBox, pickerBox] = await Promise.all([command.boundingBox(), picker.boundingBox()])
    if (commandBox === null || pickerBox === null) throw new Error('Composer controls must be visible for layout acceptance')
    const commandCenterY = commandBox.y + commandBox.height / 2
    const pickerCenterY = pickerBox.y + pickerBox.height / 2
    expect(Math.abs(commandCenterY - pickerCenterY)).toBeLessThanOrEqual(1)
    expect(pickerBox.x).toBeGreaterThan(commandBox.x + commandBox.width)
    expect(pickerBox.x - (commandBox.x + commandBox.width)).toBeLessThanOrEqual(20)
  })

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

  test('exports and restores configuration, sessions, and complete Backup scopes independently', async ({ page }, testInfo) => {
    await enterApp(page)
    await connectAcceptanceWorkspace(page)
    let dialog = await openSettings(page, '子代理')
    const enabled = dialog.getByLabel('启用连续模式')
    await enabled.check()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled()

    await page.reload()
    dialog = await openSettings(page, '子代理')
    await expect(dialog.getByLabel('启用连续模式')).toBeChecked()
    await dialog.getByRole('button', { name: '备份', exact: true }).click()

    await dialog.getByRole('radio', { name: '配置', exact: true }).click()
    let downloadPromise = page.waitForEvent('download')
    await dialog.getByRole('button', { name: '导出所选内容', exact: true }).click()
    await expect(dialog.getByLabel('备份生成进度')).toBeVisible()
    let download = await downloadPromise
    const configurationArchive = testInfo.outputPath('configuration-backup.zip')
    await download.saveAs(configurationArchive)
    await dialog.getByText('配置备份已生成，浏览器已开始下载。', { exact: true }).waitFor()

    await dialog.getByRole('radio', { name: '会话', exact: true }).click()
    downloadPromise = page.waitForEvent('download')
    await dialog.getByRole('button', { name: '导出所选内容', exact: true }).click()
    download = await downloadPromise
    const sessionsArchive = testInfo.outputPath('sessions-backup.zip')
    await download.saveAs(sessionsArchive)
    await dialog.getByText('会话备份已生成，浏览器已开始下载。', { exact: true }).waitFor()

    await dialog.getByRole('radio', { name: '全部', exact: true }).click()
    downloadPromise = page.waitForEvent('download')
    await dialog.getByRole('button', { name: '导出所选内容', exact: true }).click()
    download = await downloadPromise
    const allArchive = testInfo.outputPath('all-backup.zip')
    await download.saveAs(allArchive)
    await dialog.getByText('完整备份已生成，浏览器已开始下载。', { exact: true }).waitFor()

    const input = dialog.locator('input[type="file"]')
    await input.setInputFiles(invalidBackup)
    await dialog.getByText('所选压缩包不是 DeepSeek Harness 备份文件。', { exact: true }).waitFor()

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await addWorkspace(page, backupWorkspace)
    dialog = await openSettings(page, '子代理')
    await dialog.getByLabel('启用连续模式').uncheck()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByRole('button', { name: '备份', exact: true }).click()
    await dialog.locator('input[type="file"]').setInputFiles(configurationArchive)
    await expect(dialog.getByLabel('备份恢复进度')).toBeVisible()
    await dialog.getByText('配置备份已导入。重新加载后将使用恢复的设置和凭据。', { exact: true }).waitFor({ timeout: 6 * 60_000 })
    allowNextNavigationAbort(page, 'POST', '/api/backup.import')
    await dialog.getByRole('button', { name: '重新加载页面', exact: true }).click()

    dialog = await openSettings(page, '子代理')
    await expect(dialog.getByLabel('启用连续模式')).toBeChecked()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('treeitem', { name: 'workspace-after-backup', exact: true })).toBeVisible()

    dialog = await openSettings(page, '子代理')
    await dialog.getByLabel('启用连续模式').uncheck()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByRole('button', { name: '备份', exact: true }).click()
    await dialog.locator('input[type="file"]').setInputFiles(sessionsArchive)
    await dialog.getByText('会话备份已导入。重新加载后将使用恢复的会话、附件和工作区。', { exact: true }).waitFor({ timeout: 6 * 60_000 })
    allowNextNavigationAbort(page, 'POST', '/api/backup.import')
    await dialog.getByRole('button', { name: '重新加载页面', exact: true }).click()

    await expect(page.getByRole('treeitem', { name: 'workspace-after-backup', exact: true })).toHaveCount(0)
    dialog = await openSettings(page, '子代理')
    await expect(dialog.getByLabel('启用连续模式')).not.toBeChecked()
    await page.keyboard.press('Escape')

    await addWorkspace(page, backupWorkspace)
    dialog = await openSettings(page, '备份')
    await dialog.locator('input[type="file"]').setInputFiles(allArchive)
    await dialog.getByText('完整备份已导入。重新加载后将使用恢复的配置、会话和工作区。', { exact: true }).waitFor({ timeout: 6 * 60_000 })
    allowNextNavigationAbort(page, 'POST', '/api/backup.import')
    await dialog.getByRole('button', { name: '重新加载页面', exact: true }).click()

    await expect(page.getByRole('treeitem', { name: 'workspace-after-backup', exact: true })).toHaveCount(0)
    dialog = await openSettings(page, '子代理')
    await expect(dialog.getByLabel('启用连续模式')).toBeChecked()
  })

  test('submits a real document and previews its cards from Chat and Trajectory', async ({ page }) => {
    await enterApp(page)
    await connectAcceptanceWorkspace(page)
    await selectAcceptanceModel(page)
    const picker = page.getByRole('button', { name: '添加文件', exact: true })
    const chooserPromise = page.waitForEvent('filechooser')
    await picker.click()
    await (await chooserPromise).setFiles(pdfFixture)
    const drafts = page.getByLabel('待发送文档')
    await expect(drafts.getByText('acceptance.pdf', { exact: true })).toBeVisible()
    const draftCards = drafts.locator(':scope > div')
    await expect(draftCards).toHaveCount(1)
    const draftCard = draftCards.first()
    const [draftsBox, draftCardBox] = await Promise.all([drafts.boundingBox(), draftCard.boundingBox()])
    if (draftsBox === null || draftCardBox === null) throw new Error('Document draft layout boxes are unavailable')
    expect(Math.abs(draftCardBox.x - draftsBox.x - 12)).toBeLessThan(1)
    expect(draftCardBox.width).toBeLessThanOrEqual(280)
    expect(draftCardBox.height).toBeLessThanOrEqual(46)
    await sendPrompt(page, "Read the attached document and reply with exactly the three uppercase words after 'The expected phrase is'.")
    const history = page.getByLabel('已附加文档').first()
    await expect(history.getByText('acceptance.pdf', { exact: true })).toBeVisible({ timeout: 3 * 60_000 })
    await page.getByText('PLUS DOCUMENT OK', { exact: true }).waitFor({ timeout: 6 * 60_000 })
    const documentPreview = page.locator('[data-dsh-better-sidebar]')
    const collapsePreview = documentPreview.getByRole('button', { name: /折叠侧边栏|Collapse sidebar/ })
    if (await collapsePreview.isVisible()) await collapsePreview.click()
    await expect(documentPreview.getByRole('button', { name: /展开侧边栏|Open sidebar/ })).toBeVisible()
    await history.getByRole('button', { name: /在侧边栏预览acceptance\.pdf|Preview acceptance\.pdf in sidebar/ }).click()
    await expect(collapsePreview).toBeVisible()
    await expect(documentPreview.locator('[title="acceptance.pdf"]')).toBeVisible()
    await expect(documentPreview.getByText(/PLUS DOCUMENT OK/)).toBeVisible()
    await collapsePreview.click()
    await expect(documentPreview.getByRole('button', { name: /展开侧边栏|Open sidebar/ })).toBeVisible()

    await page.getByRole('tab', { name: /轨迹|Trajectory/ }).click()
    await page.getByRole('row', { name: /用户.*Read the attached document/ }).click()
    const trajectoryHistory = page.getByLabel('已附加文档')
    await expect(trajectoryHistory.getByText('acceptance.pdf', { exact: true }).first()).toBeVisible()
    await trajectoryHistory.getByRole('button', { name: /在侧边栏预览acceptance\.pdf|Preview acceptance\.pdf in sidebar/ }).click()
    await expect(collapsePreview).toBeVisible()
    await expect(documentPreview.locator('[title="acceptance.pdf"]')).toBeVisible()
    await expect(documentPreview.getByText(/PLUS DOCUMENT OK/)).toBeVisible()
    await page.getByRole('tab', { name: /对话|Chat/ }).click()
  })

  test('authorizes DataOps through its real UI and renders a dsh-genui chart from the result', async ({ page }, testInfo) => {
    await enterApp(page)
    await connectAcceptanceWorkspace(page)
    const dialog = await openSettings(page, 'DataOps')
    const connected = dialog.getByText('已连接', { exact: true })
    const notConnected = dialog.getByText('未连接', { exact: true })
    const loginExpired = dialog.getByText('登录已过期', { exact: true })
    await expect(connected.or(notConnected).or(loginExpired)).toBeVisible()
    if (!(await connected.isVisible())) {
      const popupPromise = page.waitForEvent('popup')
      const signInAgain = page.getByRole('dialog', { name: /登录已过期|Sign-in expired/ })
        .getByRole('button', { name: /重新登录|Sign in again/ })
      const connect = dialog.getByRole('button', { name: '连接 DataOps', exact: true })
      await expect(signInAgain.or(connect)).toBeVisible()
      if (await signInAgain.isVisible()) await signInAgain.click()
      else await connect.click()
      const popup = await popupPromise
      watchDiagnostics(popup)
      const authorize = popup.getByRole('button', { name: /授权并返回|Authorize and return/ })
      const loginRequired = popup.getByRole('button', { name: /PKI登录|PKI login/ })
      await expect(authorize.or(loginRequired)).toBeVisible({ timeout: 60_000 })
      if (await loginRequired.isVisible()) {
        const username = process.env.DSH_PLUS_TEST_DATAOPS_USERNAME
        const password = process.env.DSH_PLUS_TEST_DATAOPS_PASSWORD
        if (!username || !password) {
          await assertDiagnostics(popup, testInfo)
          throw new Error('DataOps authorization requires DSH_PLUS_TEST_DATAOPS_USERNAME and DSH_PLUS_TEST_DATAOPS_PASSWORD')
        }
        await popup.getByRole('button', { name: /账号密码|Password/ }).click()
        await popup.getByRole('textbox', { name: /用户名或邮箱|Username or email/ }).fill(username)
        await popup.getByRole('textbox', { name: /密码|Password/ }).fill(password)
        await popup.getByRole('button', { name: /进入工作台|Enter workspace/ }).click()
        const loginFailure = popup.locator('[role="alert"].el-message--error')
        await expect(authorize.or(loginFailure)).toBeVisible({ timeout: 30_000 })
        if (await loginFailure.isVisible()) throw new Error('DataOps account login failed in the real UI')
      }
      const account = popup.getByRole('radio').first()
      await expect(account).toBeVisible({ timeout: 30_000 })
      await account.check()
      await expect(authorize).toBeEnabled({ timeout: 30_000 })
      await authorize.click()
      await popup.waitForEvent('close', { timeout: 60_000 })
      await assertDiagnostics(popup, testInfo)
    }
    const authorizationFailure = dialog.getByRole('alert')
    await expect(connected.or(authorizationFailure)).toBeVisible({ timeout: 30_000 })
    if (await authorizationFailure.isVisible()) {
      throw new Error(`DataOps authorization failed in Settings: ${await authorizationFailure.innerText()}`)
    }
    await page.reload()
    await page.getByRole('button', { name: /新建会话|New session/ }).first().click()
    await selectAcceptanceModel(page, 'Low')
    const composer = page.locator('[data-composer-input][contenteditable="true"]')
    await composer.fill('/gen')
    const skillMenu = page.getByRole('listbox')
    await expect(skillMenu.getByRole('option', { name: /genui/ })).toBeVisible({ timeout: 30_000 })
    const stopGenerating = page.getByRole('button', { name: /停止生成|Stop generating/ })
    const send = page.getByRole('button', { name: /发送消息|Send message/ })
    const clarification = page.getByRole('button', { name: /^(提交|Submit)$/ })
    const genui = page.locator('[data-genui]').last()
    const chart = genui.locator('svg:has(path):has(circle title)')
    const panel = page.getByRole('button', { name: /^(面板|Panel)/ }).last()

    await sendPrompt(page, '/genui 请从我有权访问的 DataOps 表中选择一个适合统计且可查询的表，执行一个返回不超过 12 行的只读聚合查询，并把真实查询结果渲染成可见的简洁折线图。使用 genui 规范里的 chart line，不要使用 echart full option；不要只用文字描述或声称已经显示。')
    await stopGenerating.waitFor({ timeout: 30_000 })
    const turnDeadline = Date.now() + 7 * 60_000
    const outcome = chart.or(panel).or(send).or(clarification).first()
    const waitForOutcome = async () => {
      const remaining = turnDeadline - Date.now()
      if (remaining <= 0) throw new Error('The GPT DataOps turn exceeded its 7-minute interaction deadline')
      await expect(outcome).toBeVisible({ timeout: remaining })
    }
    try {
      await waitForOutcome()
      let clarificationCount = 0
      while (await clarification.isVisible()) {
        if (clarificationCount >= 3) throw new Error('The GPT DataOps turn requested more than three clarifications')
        await answerFirstClarification(page)
        clarificationCount += 1
        await waitForOutcome()
      }
    } catch (error) {
      const projectedTools = await projectedToolStates(page)
      const failures = [error]
      if (await stopGenerating.isVisible()) {
        try {
          await stopGenerating.click({ timeout: 5_000 })
          await send.waitFor({ timeout: 30_000 })
        } catch (cancellationError) {
          failures.push(cancellationError)
        }
      }
      throw new AggregateError(
        failures,
        `DataOps chart was not rendered before the 7-minute interaction deadline; projected tool states: ${projectedTools.join(', ') || 'none'}`,
      )
    }
    if (!(await chart.isVisible()) && await panel.isVisible()) {
      await panel.click()
      await expect(chart).toBeVisible()
    }
    if (!(await chart.isVisible())) {
      const projectedTools = await projectedToolStates(page)
      throw new Error(
        `The GPT turn completed without rendering the requested DataOps chart; projected tool states: ${projectedTools.join(', ') || 'none'}`,
      )
    }
    await expect(genui).toBeVisible()
    await expect(chart.locator('path')).toBeVisible()
    await expect(chart.locator('circle title')).not.toHaveCount(0)
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

  test('keeps Session export in the mobile Header and hides the desktop toolbar action', async ({ page }) => {
    await enterApp(page)
    await connectAcceptanceWorkspace(page)
    await sendPrompt(page, '/goal clear')
    const header = page.locator('[data-slot="conversation.session.header.utilities"]')
    await expect(header.getByRole('button', { name: '会话日志', exact: true })).toBeVisible()

    await page.getByRole('tab', { name: /轨迹|Trajectory/ }).click()
    const toolbar = page.getByRole('toolbar', { name: '轨迹工具栏', exact: true })
    await expect(toolbar.locator('button').filter({ hasText: '会话日志' })).toBeHidden()
    await expect(header.getByRole('button', { name: '会话日志', exact: true })).toBeVisible()
  })
})
