import { expect, test, _electron as electron } from 'playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 等待备份窗口显示成功状态；期间出现错误文本则立即携带错误内容失败。 */
async function expectResult(backup, successText, timeoutMs) {
  const status = backup.locator('#status')
  const error = backup.locator('#error')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const statusText = await status.textContent() ?? ''
    if (statusText.includes(successText)) return statusText
    const errorText = (await error.textContent() ?? '').trim()
    if (errorText !== '') throw new Error('Backup operation failed: ' + errorText)
    if (Date.now() > deadline) throw new Error('Timed out waiting for "' + successText + '"; status="' + statusText + '"')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

test('installer validates directory provider proxy and retry controls', async ({}, testInfo) => {
  const application = await electron.launch({
    args: ['.', '--user-data-dir=' + testInfo.outputPath('user-data')],
    cwd: desktopDirectory,
  })
  try {
    const page = await application.firstWindow()
    const layout = await page.evaluate(() => {
      const stepper = document.querySelector('#stepper').getBoundingClientRect()
      const panel = document.querySelector('.panel.active').getBoundingClientRect()
      const heading = document.querySelector('.panel.active h1').getBoundingClientRect()
      return {
        aligned: Math.abs(stepper.left - panel.left),
        gap: heading.top - stepper.bottom,
        headerBorder: getComputedStyle(document.querySelector('.brand-bar')).borderBottomWidth,
        footerBorder: getComputedStyle(document.querySelector('.action-bar')).borderTopWidth,
      }
    })
    expect(layout.aligned).toBeLessThan(2)
    expect(layout.gap).toBeGreaterThan(20)
    expect(layout.headerBorder).toBe('0px')
    expect(layout.footerBorder).toBe('0px')
    await page.getByRole('button', { name: '继续' }).click()
    await page.getByRole('button', { name: '选择文件夹' }).click()

    const browser = page.getByRole('dialog', { name: '选择安装目录' })
    await expect(browser).toBeVisible()
    await expect(browser.locator('.directory-column')).toHaveCount(1)
    await expect(browser.locator('#directoryPath')).not.toHaveValue('C:\\Users\\you')
    await browser.locator('.directory-row').first().click()
    await expect(browser.locator('.directory-column')).toHaveCount(2)
    await expect(browser.locator('.directory-row[aria-current="true"]')).toHaveCount(1)
    await browser.getByRole('button', { name: '新建文件夹' }).click()
    const createFolder = page.getByRole('dialog', { name: '新建文件夹' })
    await createFolder.locator('#directoryNewName').fill('dsh-installer-retry-test')
    await createFolder.getByRole('button', { name: '创建' }).click()
    await expect(createFolder).toBeHidden()
    await browser.getByRole('button', { name: '打开' }).click()
    await expect(page.locator('#installPath')).not.toHaveValue('')
    await page.getByText('高级选项', { exact: true }).click()
    await page.locator('#candidatePort').fill('3181')
    await page.locator('#supervisorPort').fill('3182')
    await page.locator('#candidateSupervisorPort').fill('3183')
    await page.locator('#proxy').fill('ftp://127.0.0.1:7890')
    await page.getByRole('button', { name: '继续' }).click()
    await expect(page.locator('#proxyError')).toHaveText('代理地址必须是 HTTP、HTTPS 或 SOCKS5 URL。')
    await expect(page.locator('#proxy')).toHaveAttribute('aria-invalid', 'true')
    await page.locator('#proxy').fill('http://127.0.0.1:1')
    await page.locator('#overwriteInstall').check()

    await page.getByRole('button', { name: '继续' }).click()
    const provider = page.locator('#provider').locator('..')
    await provider.locator('.select-trigger').click()
    await expect(provider.locator('.select-check:not([hidden])')).toHaveCount(1)
    await provider.getByRole('option', { name: '自定义提供方', exact: true }).click()
    await expect(page.locator('#customProvider')).toBeVisible()

    await page.locator('#apiKey').fill('sk-test-key')
    await page.locator('#model').fill('gpt-5.6')
    await page.locator('#customName').fill('Gateway')
    await page.getByRole('button', { name: '继续' }).click()
    await expect(page.locator('#customProviderError')).toHaveText('请填写服务地址。')
    await expect(page.locator('#baseURL')).toHaveAttribute('aria-invalid', 'true')

    await page.locator('#baseURL').fill('https://gateway.example.com/v1')
    await page.getByRole('button', { name: '继续' }).click()
    await expect(page.getByRole('heading', { name: '确认安装' })).toBeVisible()
    await expect(page.locator('#summary')).toContainText('http://127.0.0.1:1/')
    await expect(page.locator('#summary')).toContainText('3181')
    await expect(page.locator('#summary')).toContainText('3182')
    await expect(page.locator('#summary')).toContainText('3183')
    await expect(page.locator('#summary')).toContainText('覆盖安装，保留用户数据')

    await page.getByRole('button', { name: '安装', exact: true }).click()
    await expect(page.locator('#retryInstall')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('#error')).toContainText('请检查下载代理后重试。')
    await page.locator('#retryInstall').click()
    await expect(page.locator('#progress')).toBeVisible()
    await expect(page.locator('#retryInstall')).toBeVisible({ timeout: 60_000 })

  } finally {
    await application.close()
  }
})

test('installer completes a native Harness installation and starts Supervisor', async ({}, testInfo) => {
  test.setTimeout(16 * 60_000)
  const installSource = testInfo.outputPath('install-source')
  execFileSync('git', ['clone', '--local', '--no-checkout', resolve(desktopDirectory, '../..'), installSource], { stdio: 'pipe' })
  const application = await electron.launch({
    args: ['.', '--user-data-dir=' + testInfo.outputPath('user-data')],
    cwd: desktopDirectory,
    env: { ...process.env, DSH_PLUS_INSTALL_REPOSITORY: installSource, DSH_PLUS_INSTALL_SOURCE_REF: 'HEAD' },
  })
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: '继续' }).click()
    await page.locator('#installPath').fill(resolve(desktopDirectory, '../..'))
    await page.getByText('高级选项', { exact: true }).click()
    await page.locator('#port').fill('45180')
    await page.locator('#candidatePort').fill('45181')
    await page.locator('#supervisorPort').fill('45182')
    await page.locator('#candidateSupervisorPort').fill('45183')
    await page.locator('#overwriteInstall').check()
    await page.getByRole('button', { name: '继续' }).click()

    await page.locator('#apiKey').fill('sk-electron-install-test')
    await page.getByRole('button', { name: '继续' }).click()
    await expect(page.getByRole('heading', { name: '确认安装' })).toBeVisible()
    await expect(page.locator('#summary')).toContainText('45182')

    const installerFinished = Promise.race([
      page.waitForEvent('close', { timeout: 14 * 60_000 }).then(() => ({ closed: true })).catch(() => undefined),
      page.locator('#error').waitFor({ state: 'visible', timeout: 14 * 60_000 }).then(async () => ({ closed: false, error: await page.locator('#error').textContent() })).catch(() => undefined),
    ])
    await page.getByRole('button', { name: '安装', exact: true }).click()
    const result = await installerFinished
    if (result?.closed !== true) throw new Error('Native installation failed: ' + String(result?.error ?? 'installer did not complete'))
    expect(application.process().exitCode).toBeNull()
  } finally {
    await application.close()
  }
})

test('backup window exports and restores the user data archive', async ({}, testInfo) => {
  test.setTimeout(22 * 60_000)
  const installSource = testInfo.outputPath('install-source')
  execFileSync('git', ['clone', '--local', '--no-checkout', resolve(desktopDirectory, '../..'), installSource], { stdio: 'pipe' })
  // 原生对话框无法被 Playwright 操作：测试驱动缝从该文件读取固定的对话框应答，业务步骤仍全部经由备份窗口 UI 完成。
  const dialogSelectionsPath = testInfo.outputPath('dialog-selections.json')
  writeFileSync(dialogSelectionsPath, JSON.stringify({}))
  const application = await electron.launch({
    args: ['.', '--user-data-dir=' + testInfo.outputPath('user-data')],
    cwd: desktopDirectory,
    env: { ...process.env, DSH_PLUS_INSTALL_REPOSITORY: installSource, DSH_PLUS_INSTALL_SOURCE_REF: 'HEAD', DSH_PLUS_DESKTOP_TEST_SEAM: '1', DSH_PLUS_DESKTOP_TEST_DIALOGS: dialogSelectionsPath },
  })
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: '继续' }).click()
    await page.locator('#installPath').fill(resolve(desktopDirectory, '../..'))
    await page.getByText('高级选项', { exact: true }).click()
    await page.locator('#port').fill('45190')
    await page.locator('#candidatePort').fill('45191')
    await page.locator('#supervisorPort').fill('45192')
    await page.locator('#candidateSupervisorPort').fill('45193')
    await page.locator('#overwriteInstall').check()
    await page.getByRole('button', { name: '继续' }).click()

    await page.locator('#apiKey').fill('sk-electron-backup-test')
    await page.getByRole('button', { name: '继续' }).click()
    await expect(page.getByRole('heading', { name: '确认安装' })).toBeVisible()

    const installerFinished = Promise.race([
      page.waitForEvent('close', { timeout: 14 * 60_000 }).then(() => ({ closed: true })).catch(() => undefined),
      page.locator('#error').waitFor({ state: 'visible', timeout: 14 * 60_000 }).then(async () => ({ closed: false, error: await page.locator('#error').textContent() })).catch(() => undefined),
    ])
    await page.getByRole('button', { name: '安装', exact: true }).click()
    const result = await installerFinished
    if (result?.closed !== true) throw new Error('Native installation failed: ' + String(result?.error ?? 'installer did not complete'))

    // 托盘菜单无法被 Playwright 点击：测试驱动缝在安装完成后自动打开备份窗口，窗口内交互全部走真实 UI。
    let backup
    for (let attempt = 0; attempt < 50 && backup === undefined; attempt += 1) {
      backup = application.windows().find(candidate => candidate.url().endsWith('backup.html'))
      if (backup === undefined) await new Promise(resolve => setTimeout(resolve, 200))
    }
    if (backup === undefined) throw new Error('Backup window did not open')
    await expect(backup.locator('#title')).toHaveText('备份与恢复')
    await expect(backup.locator('#location')).toContainText('.dsh-plus')

    const exportPath = testInfo.outputPath('user-backup.zip')
    writeFileSync(dialogSelectionsPath, JSON.stringify({ savePath: exportPath }))
    await backup.getByRole('button', { name: '导出备份压缩包' }).click()
    await expectResult(backup, '备份已导出', 120_000)
    const archive = new AdmZip(exportPath)
    const entryNames = archive.getEntries().map(entry => entry.entryName)
    expect(entryNames).toContain('settings.yaml')
    expect(entryNames).toContain('backup-manifest.json')
    // 用户配置的模型（provider/model/reasoningEffort）写在 settings.yaml；密钥明文（不只是引用名）在 .credentials.yaml：备份必须带上它们。
    const settingsEntry = archive.getEntries().find(entry => entry.entryName === 'settings.yaml')
    expect(settingsEntry.getData().toString('utf8')).toContain('agent-default-model')
    // 覆盖安装保留已有凭据文件，其中密钥明文来自先运行的安装用例：断言引用名和密钥值本身都在包里。
    const credentialsEntry = archive.getEntries().find(entry => entry.entryName === '.credentials.yaml')
    const credentialsText = credentialsEntry.getData().toString('utf8')
    expect(credentialsText).toContain('DSH_INSTALLER_DEEPSEEK_OFFICIAL_API_KEY')
    expect(credentialsText).toContain('sk-electron-install-test')
    expect(entryNames).toContain('storages/workspace.json')
    expect(entryNames.some(name => name.startsWith('profiles/'))).toBe(false)

    const invalidArchivePath = testInfo.outputPath('invalid.zip')
    const invalidArchive = new AdmZip()
    invalidArchive.addFile('not-a-backup.txt', Buffer.from('no manifest here'))
    invalidArchive.writeZip(invalidArchivePath)
    writeFileSync(dialogSelectionsPath, JSON.stringify({ openPath: invalidArchivePath, confirm: 0 }))
    await backup.getByRole('button', { name: '选择压缩包并导入' }).click()
    await expect(backup.locator('#error')).toContainText('所选压缩包不是 DeepSeek Harness Plus 备份文件。', { timeout: 60_000 })
    await expect(backup.getByRole('button', { name: '选择压缩包并导入' })).toBeEnabled()

    const settingsPath = resolve(desktopDirectory, '../..', '.dsh-plus', 'home', 'settings.yaml')
    writeFileSync(settingsPath, 'locale:\n  preference: en\n')
    writeFileSync(dialogSelectionsPath, JSON.stringify({ openPath: exportPath, confirm: 0 }))
    await backup.getByRole('button', { name: '选择压缩包并导入' }).click()
    const importedStatus = await expectResult(backup, '备份已导入', 6 * 60_000)
    expect(importedStatus).toContain('Harness 已重新启动')
    const restoredSettings = readFileSync(settingsPath, 'utf8')
    expect(restoredSettings).toContain('"zh"')
    expect(restoredSettings).toContain('agent-default-model')
  } finally {
    await application.close()
  }
})
