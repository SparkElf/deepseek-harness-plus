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
    await page.getByRole('button', { name: '继续' }).click()
    await page.getByRole('button', { name: '选择文件夹' }).click()

    const browser = page.getByRole('dialog', { name: '选择安装目录' })
    await expect(browser).toBeVisible()
    await browser.locator('.directory-row').first().click()
    await browser.getByRole('button', { name: '打开' }).click()
    await expect(page.locator('#installPath')).not.toHaveValue('')

    await page.getByRole('button', { name: '继续' }).click()
    const provider = page.locator('.select-control:visible').first()
    await provider.locator('.select-trigger').click()
    await expect(provider.locator('.select-check:not([hidden])')).toHaveCount(1)
    await provider.getByRole('option', { name: '自定义提供方', exact: true }).click()

    await page.locator('#model').fill('gpt-5.6')
    await page.locator('#customName').fill('Gateway')
    await page.getByRole('button', { name: '继续' }).click()
    await expect(page.locator('#customProviderError')).toHaveText('请填写服务地址。')
    await expect(page.locator('#baseURL')).toHaveAttribute('aria-invalid', 'true')

    await page.locator('#baseURL').fill('https://gateway.example.com/v1')
    await page.getByRole('button', { name: '继续' }).click()
    await expect(page.getByRole('heading', { name: '确认安装' })).toBeVisible()

    const initialWidth = await page.locator('.brand-bar').evaluate(element => element.getBoundingClientRect().width)
    await page.getByRole('button', { name: '最大化' }).click()
    await expect.poll(async () => page.locator('.brand-bar').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(initialWidth)
    const closed = page.waitForEvent('close')
    await page.getByRole('button', { name: '关闭' }).click()
    await closed
  } finally {
    await application.close()
  }
})
