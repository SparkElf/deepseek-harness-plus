// Web e2e scenario: the settings Backup section — a UI-driven closed loop
// over the real Host: seed the isolated harness home, export one zip archive
// through the section's export action (browser download), assert the archive
// carries the seeded user data plus the manifest marker and excludes the
// runtime-generated directories, tamper the home, import the same archive
// through the hidden file input, and assert the tampered file is restored.
// Zero model calls: pure client + Host filesystem state.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { unzipSync } from 'fflate'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { join } from 'node:path'
import {
  launchWebScaffold, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

describe('web e2e: settings Backup section export/import round-trip', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    // Seed the harness home BEFORE launch: the scaffold merges its onboarding
    // acknowledgement into the settings document at boot, so the seeded file
    // must already exist for the ack to land beside it.
    const home = mkdtempSync(join(tmpdir(), 'dsh-backup-home-'))
    mkdirSync(join(home, 'storages'), { recursive: true })
    mkdirSync(join(home, 'profiles'), { recursive: true })
    writeFileSync(join(home, 'settings.yaml'), 'locale:\n  preference: "zh"\n')
    writeFileSync(join(home, '.credentials.yaml'), 'DSH_INSTALLER_KEY: "sk-backup-e2e"\n')
    chmodSync(join(home, '.credentials.yaml'), 0o600)
    writeFileSync(join(home, 'storages', 'workspace.json'), '{"marker":true}')
    writeFileSync(join(home, 'profiles', 'generated.txt'), 'runtime')
    scaffold = await launchWebScaffold({ harnessHome: home })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('exports a backup archive and imports it back over a tampered home', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-backup'))
    const trigger = page.getByRole('button', { name: '设置', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '备份', exact: true }).click()
    await dialog.getByText('备份与恢复').waitFor({ timeout: 10_000 })

    // Export: the section hands the archive to the browser as a download.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      dialog.getByRole('button', { name: '导出备份压缩包' }).click(),
    ])
    const archivePath = await download.path()
    expect(archivePath).not.toBeNull()
    await dialog.getByText('备份已导出').waitFor({ timeout: 10_000 })
    const entries = unzipSync(new Uint8Array(readFileSync(archivePath)))
    const names = Object.keys(entries)
    expect(names).toContain('settings.yaml')
    expect(names).toContain('.credentials.yaml')
    expect(names).toContain('storages/workspace.json')
    expect(names).toContain('backup-manifest.json')
    expect(names.some(name => name.startsWith('profiles/'))).toBe(false)
    expect(new TextDecoder().decode(entries['settings.yaml'] as Uint8Array)).toContain('zh')

    // Tamper the home, then import the archive back through the file input.
    writeFileSync(join(scaffold.harnessHome, 'settings.yaml'), 'locale:\n  preference: en\n')
    const input = dialog.locator('input[type="file"]')
    await input.setInputFiles(archivePath)
    await dialog.getByText('备份已导入').waitFor({ timeout: 30_000 })
    expect(readFileSync(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).toContain('"zh"')
    expect(tripwire.pageErrors).toEqual([])
  })

  it('rejects an archive without the manifest marker with localized copy', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-backup-reject'))
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByRole('button', { name: '备份', exact: true }).click()
    await dialog.getByText('备份与恢复').waitFor({ timeout: 10_000 })
    const badPath = join(scaffold.workspaceCwd, 'not-a-backup.zip')
    const { zipSync } = await import('fflate')
    writeFileSync(badPath, Buffer.from(zipSync({ 'hello.txt': new TextEncoder().encode('x') })))
    await dialog.locator('input[type="file"]').setInputFiles(badPath)
    await dialog.getByText('所选压缩包不是 DeepSeek Harness 备份文件。').waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  })
})
