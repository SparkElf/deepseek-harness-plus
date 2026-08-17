import { expect, test, _electron as electron } from 'playwright/test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('installer lets an operator choose a directory and complete custom provider validation', async ({}, testInfo) => {
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
