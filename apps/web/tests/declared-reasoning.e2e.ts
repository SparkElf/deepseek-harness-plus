// Web e2e scenario: a hand-declared model's `reasoningEfforts` reaches the
// composer's effort pane — the levels a settings profile declares are exactly
// what the picker offers, and picking one records it with the Agent default.
// Zero model calls: declaring, describing, and switching are settings/llm
// traffic only, so there is no fixture and a stray stream would fail loud.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

/** Starts the shipped default on this scenario's declared reasoning model. */
const OVERLAY = fileURLToPath(new URL('./declared-reasoning.overlay.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/declared-reasoning', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./expected/declared-reasoning/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: declared reasoning efforts reach the composer', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    // The whole reasoning offer is the profile: key = selectable level, value
    // = the wire spelling dispatch would send (`max: ultra` renames; the
    // valueless `off` means "supported, send nothing"). The route sets no
    // deployment default, so the pane leads with the provider-default entry.
    await scaffold.ctx.settings.update('llm-pi-ai', {
      providers: {
        'acme-gateway': {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          models: [{
            id: 'acme-think',
            name: 'Acme Think',
            reasoningEfforts: { off: null, high: 'high', max: 'ultra' },
          }],
        },
      },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('offers exactly the declared levels and records the picked one', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-declared-reasoning'))
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    await page.getByRole('menuitem', { name: /推理等级/ }).click()

    // Declared levels, nothing else: the provider-default entry (the route
    // configures no `reasoning`), then Off/High/Max — minimal, low, medium,
    // and xhigh were not declared and must not be offered.
    const levels = page.getByRole('menuitemradio')
    await expect.poll(async () => levels.allTextContents(), { timeout: 10_000 })
      .toEqual(['Default', 'Off', 'High', 'Max'])
    const snapshot = await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

    // Picking a level is the same gesture that saves the default selection, so
    // the effort lands in the Agent default Settings section beside provider/model.
    await page.getByRole('menuitemradio', { name: 'High' }).click()
    await expect.poll(
      async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'),
      { timeout: 10_000 },
    ).toContain('reasoningEffort: high')
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('选择模型，当前 Acme Think，推理等级 High')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('collapses the model trigger before the composer toolbar can wrap', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-responsive-model-trigger'))
    const trigger = page.locator('[data-model-trigger]')
    await trigger.waitFor({ timeout: 15_000 })
    if (!((await trigger.getAttribute('aria-label'))?.endsWith('High') ?? false)) {
      await trigger.click()
      await page.getByRole('menuitem', { name: /推理等级/ }).click()
      await page.getByRole('menuitemradio', { name: 'High' }).click()
      await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 10_000 })
        .toBe('选择模型，当前 Acme Think，推理等级 High')
    }
    await page.getByRole('button', { name: /收起侧边栏|Collapse sidebar/i }).click()

    const measure = async (width: number) => {
      await page.setViewportSize({ width, height: 820 })
      await page.locator('[data-composer-toolbar]').evaluate(async (row) => {
        const deadline = performance.now() + 5_000
        let previous = row.getBoundingClientRect().width
        let stableFrames = 0
        while (performance.now() < deadline) {
          await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
          const current = row.getBoundingClientRect().width
          stableFrames = Math.abs(current - previous) < 0.01 ? stableFrames + 1 : 0
          if (stableFrames >= 3) return
          previous = current
        }
        throw new Error('composer toolbar width did not settle after viewport change')
      })
      return page.evaluate(() => {
        const row = document.querySelector<HTMLElement>('[data-composer-toolbar]')
        const tools = document.querySelector<HTMLElement>('[data-composer-tools]')
        const trailing = document.querySelector<HTMLElement>('[data-composer-trailing]')
        const model = document.querySelector<HTMLElement>('[data-model-trigger]')
        const icon = document.querySelector<HTMLElement>('[data-model-trigger-icon]')
        const label = model?.children[1]
        const effort = model?.children[2]
        if (row === null || tools === null || trailing === null || model === null || icon === null) {
          throw new Error('responsive composer measurement target is missing')
        }
        const box = (element: HTMLElement) => element.getBoundingClientRect()
        return {
          rowHeight: box(row).height,
          rowClientWidth: row.clientWidth,
          rowScrollWidth: row.scrollWidth,
          toolsRight: box(tools).right,
          trailingLeft: box(trailing).left,
          toolsY: box(tools).y,
          trailingY: box(trailing).y,
          icon: getComputedStyle(icon).display,
          label: label instanceof HTMLElement ? getComputedStyle(label).display : 'missing',
          effort: effort instanceof HTMLElement && !effort.matches('svg') ? getComputedStyle(effort).display : 'none',
          title: model.title,
          ariaLabel: model.getAttribute('aria-label'),
        }
      })
    }

    const full = await measure(702)
    const compact = await measure(600)
    const iconOnly = await measure(418)
    for (const metrics of [full, compact, iconOnly]) {
      expect(metrics.rowHeight).toBeLessThanOrEqual(42)
      expect(metrics.rowScrollWidth).toBe(metrics.rowClientWidth)
      expect(metrics.toolsRight).toBeLessThanOrEqual(metrics.trailingLeft)
      expect(Math.abs(metrics.toolsY - metrics.trailingY)).toBeLessThanOrEqual(4)
      expect(metrics.title).toBe('Acme Think · High')
      expect(metrics.ariaLabel).toBe('选择模型，当前 Acme Think，推理等级 High')
    }
    expect(full).toMatchObject({ icon: 'none', label: 'block', effort: 'block' })
    expect(compact).toMatchObject({ icon: 'none', label: 'block', effort: 'none' })
    expect(iconOnly).toMatchObject({ icon: 'flex', label: 'none', effort: 'none' })

    await page.setViewportSize({ width: 1000, height: 820 })
    await page.waitForTimeout(300)
    await trigger.click()
    const wideMenu = page.getByRole('menu', { name: '模型与推理等级' })
    await wideMenu.waitFor()
    expect(await wideMenu.evaluate(element => element.parentElement === document.body)).toBe(false)
    await page.keyboard.press('Escape')

    const card = page.locator('[data-composer-card]')
    await card.evaluate((element) => {
      element.style.width = '300px'
      element.style.maxWidth = '300px'
    })
    await page.waitForTimeout(300)
    await trigger.click()
    const constrainedMenu = page.getByRole('menu', { name: '模型与推理等级' })
    await constrainedMenu.waitFor()
    const constrainedBox = await constrainedMenu.boundingBox()
    if (constrainedBox === null) throw new Error('constrained desktop model menu has no layout box')
    expect(await constrainedMenu.evaluate(element => element.parentElement === document.body)).toBe(true)
    expect(constrainedBox.width).toBeLessThanOrEqual(240)
    expect(constrainedBox.x).toBeGreaterThanOrEqual(12)
    expect(constrainedBox.x + constrainedBox.width).toBeLessThanOrEqual(988)
    await page.keyboard.press('Escape')
    await card.evaluate((element) => {
      element.style.removeProperty('width')
      element.style.removeProperty('max-width')
    })
    await page.setViewportSize({ width: 418, height: 820 })
    await page.waitForTimeout(300)

    await trigger.click()
    const menu = page.getByRole('menu', { name: '模型与推理等级' })
    await menu.waitFor()
    const menuBox = await menu.boundingBox()
    if (menuBox === null) throw new Error('mobile model menu has no layout box')
    expect(menuBox.x).toBeGreaterThanOrEqual(12)
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(418 - 12)
    expect(menuBox.width).toBeLessThanOrEqual(240)
    const rootRows = await menu.getByRole('menuitem').allTextContents()
    expect(rootRows).toEqual(['模型Acme Think', '推理等级High'])
    await page.keyboard.press('Escape')
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
