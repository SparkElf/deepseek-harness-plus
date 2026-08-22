// Web e2e: /goal opts its command input into the human transcript while the
// command remains log-only. The shipped composition has no model adapter, so an
// accidental turn fails loud through the same real Host and browser path.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria,
  compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/goal-command-presentation', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL(
  './snapshots/goal-command-presentation/ui.expected.md', import.meta.url,
))
const MODE = webSnapshotMode()

describe('web e2e: /goal human transcript presentation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('runs goal clear, then starts a clean welcome session', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-goal-command-presentation'))
    await expect.poll(() => page.getByText('Into the Unknown', { exact: false }).count(), {
      timeout: 15_000,
    }).toBe(1)
    const input = page.locator('textarea').first()
    await input.fill('/goal clear')
    await input.press('Enter')

    const commandInput = page.getByRole('group', { name: 'Command input' })
    await commandInput.waitFor({ timeout: 10_000 })
    await expect.poll(() => commandInput.textContent()).toBe('/goal clear')
    expect(await commandInput.getByRole('button').count()).toBe(0)
    const resultRow = page.getByText('No goal to clear.', { exact: true })
    await expect.poll(() => resultRow.count(), { timeout: 10_000 }).toBe(1)
    expect(await page.getByText('Into the Unknown', { exact: false }).count()).toBe(0)

    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

    await page.getByRole('button', { name: 'New session' }).first().click()
    await expect.poll(() => page.getByText('Into the Unknown', { exact: false }).count(), {
      timeout: 15_000,
    }).toBe(1)
    expect(await commandInput.count()).toBe(0)
    expect(await resultRow.count()).toBe(0)
    expect(await input.inputValue()).toBe('')

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  }, 120_000)
})
