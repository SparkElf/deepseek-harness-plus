// Web e2e scenario: the configurable tab in Plugins settings — the cards a
// deployment's exposed host-plane namespaces produce, one field edited through the real
// wire down to `$DSH_HOME/settings.yaml`, and the override badge and reset
// that layering produces. Zero model calls: everything is client state plus
// the settings document on a blank frame, so there is no fixture and a stray
// stream would fail loud on the open llm seam.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { join } from 'node:path'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/plugin-config', import.meta.url))
const SECTION_EXPECTED = join(SNAPSHOT_DIR, 'section.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: plugin configuration section', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    // Chinese browser: the section asserts the localized copy the client
    // derives from it, as the rest of the settings surface does.
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /** Open one settings section after closing any dialog left by a prior scenario. */
  async function openSection(section: '插件' | '子代理') {
    if (await page.getByRole('dialog', { name: '设置' }).count() > 0) {
      await page.keyboard.press('Escape')
      await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 5_000 }).toBe(0)
    }
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: section, exact: true }).click()
    await expect
      .poll(() => dialog.getByRole('button', { name: section, exact: true }).getAttribute('aria-current'), { timeout: 5_000 })
      .toBe('true')
    return dialog
  }

  async function openPlugins() {
    const dialog = await openSection('插件')
    await expect
      .poll(() => dialog.getByRole('tab', { name: '插件配置', exact: true }).getAttribute('aria-selected'), { timeout: 5_000 })
      .toBe('true')
    return dialog
  }

  /** The settings document as the Host has written it so far. */
  async function settingsDocument(): Promise<string> {
    return readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8').catch(() => '')
  }

  it('shows one card per exposed host-plane namespace', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-cards'))
    const dialog = await openPlugins()

    // Current-model Web Search follows the Models page, while subagent modes
    // have their own Settings section. Neither appears as a plugin card here.
    await dialog.getByText('终端', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await dialog.getByText('Agent 循环', { exact: true }).count()).toBe(1)
    expect(await dialog.getByText('网页搜索', { exact: true }).count()).toBe(0)
    expect(await dialog.getByText('连续子代理', { exact: true }).count()).toBe(0)
    expect(await dialog.getByText('一次性子代理', { exact: true }).count()).toBe(0)
    // Collapsed: a card's fields appear only once it is expanded.
    expect(await dialog.getByLabel('命令超时（毫秒）').count()).toBe(0)

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(SECTION_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('groups both delegation modes with disabled and zero-depth defaults', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-settings'))
    let dialog = await openSection('子代理')
    const continuous = dialog.getByRole('tab', { name: '连续子代理', exact: true })
    const oneShot = dialog.getByRole('tab', { name: '一次性子代理', exact: true })
    await continuous.waitFor({ timeout: 10_000 })
    expect(await continuous.getAttribute('aria-selected')).toBe('true')
    expect(await dialog.getByRole('switch', { name: '启用连续模式' }).isChecked()).toBe(false)
    expect(await dialog.getByRole('button', { name: '最大子代理嵌套层数' }).textContent()).toBe('0')

    await oneShot.click()
    expect(await dialog.getByRole('switch', { name: '启用一次性模式' }).isChecked()).toBe(false)
    expect(await dialog.getByRole('button', { name: '最大子代理嵌套层数' }).textContent()).toBe('0')
    await dialog.getByRole('switch', { name: '启用一次性模式' }).click()
    await continuous.click()
    expect(await dialog.getByRole('switch', { name: '启用连续模式' }).isChecked()).toBe(false)
    await oneShot.click()
    expect(await dialog.getByRole('switch', { name: '启用一次性模式' }).isChecked()).toBe(true)
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => dialog.getByRole('button', { name: '保存', exact: true }).isDisabled(), { timeout: 10_000 }).toBe(true)

    dialog = await openSection('子代理')
    await dialog.getByRole('tab', { name: '一次性子代理', exact: true }).click()
    await expect.poll(() => dialog.getByRole('switch', { name: '启用一次性模式' }).isChecked(), { timeout: 5_000 }).toBe(true)
    await dialog.getByRole('button', { name: '恢复默认', exact: true }).click()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => dialog.getByRole('switch', { name: '启用一次性模式' }).isChecked(), { timeout: 5_000 }).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('stages an edit and writes it only when saved', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-write'))
    const dialog = await openPlugins()
    await dialog.getByText('终端', { exact: true }).click()

    const timeout = dialog.getByLabel('命令超时（毫秒）')
    await timeout.waitFor({ timeout: 10_000 })
    // The composed default this deployment ships, before any user layer.
    expect(await timeout.inputValue()).toBe('60000')
    await timeout.fill('12000')
    await timeout.blur()

    // Nothing crosses the wire until the user saves: leaving the control is
    // not a decision to store the value.
    expect(await settingsDocument()).not.toContain('timeoutMs')
    const save = dialog.getByRole('button', { name: '保存', exact: true })
    await expect.poll(() => save.isEnabled(), { timeout: 5_000 }).toBe(true)
    await save.click()

    await expect.poll(async () => (await settingsDocument()).includes('timeoutMs: 12000'), { timeout: 10_000 })
      .toBe(true)
    // Presence in the user layer is what the badge reports, and the reset is
    // offered only for a field that has one.
    await expect.poll(() => dialog.getByText('已覆盖').count(), { timeout: 5_000 }).toBe(1)
    expect(await dialog.getByRole('button', { name: '恢复默认' }).count()).toBe(1)
    // A settled form offers no save to repeat.
    await expect.poll(() => save.isDisabled(), { timeout: 5_000 }).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('drops a staged edit on discard without touching the document', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-discard'))
    const dialog = await openPlugins()
    await dialog.getByText('终端', { exact: true }).click()
    const timeout = dialog.getByLabel('命令超时（毫秒）')
    await timeout.waitFor({ timeout: 10_000 })

    await timeout.fill('7000')
    await dialog.getByRole('button', { name: '放弃修改' }).click()

    await expect.poll(() => timeout.inputValue(), { timeout: 5_000 }).toBe('12000')
    expect(await settingsDocument()).toContain('timeoutMs: 12000')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('refuses to save a draft that is not a number', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-invalid'))
    const dialog = await openPlugins()
    await dialog.getByText('终端', { exact: true }).click()
    const timeout = dialog.getByLabel('命令超时（毫秒）')
    await timeout.waitFor({ timeout: 10_000 })

    await timeout.fill('soon')

    const save = dialog.getByRole('button', { name: '保存', exact: true })
    await expect.poll(() => save.isDisabled(), { timeout: 5_000 }).toBe(true)
    expect(await dialog.getByText('请填数字；留空表示使用默认值。').count()).toBe(1)
    await dialog.getByRole('button', { name: '放弃修改' }).click()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('clears the field back to the composed default on reset', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-reset'))
    const dialog = await openPlugins()
    await dialog.getByText('终端', { exact: true }).click()
    const timeout = dialog.getByLabel('命令超时（毫秒）')
    await timeout.waitFor({ timeout: 10_000 })
    expect(await timeout.inputValue()).toBe('12000')

    // The reset stages the composed default; the document still carries the
    // override until the save lands.
    await dialog.getByRole('button', { name: '恢复默认' }).click()
    await expect.poll(() => timeout.inputValue(), { timeout: 5_000 }).toBe('60000')
    expect(await settingsDocument()).toContain('timeoutMs: 12000')

    await dialog.getByRole('button', { name: '保存', exact: true }).click()

    await expect.poll(async () => (await settingsDocument()).includes('timeoutMs'), { timeout: 10_000 })
      .toBe(false)
    expect(await timeout.inputValue()).toBe('60000')
    expect(await dialog.getByText('已覆盖').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['section.expected.md'])
  })
})
