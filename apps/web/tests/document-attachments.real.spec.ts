/**
 * Real UI acceptance against an externally booted candidate with its production model,
 * attachment store, and MinerU profile; environment variables name only user inputs.
 */
import { basename } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { newEnglishPage, saveFailureShot } from './support.ts'

const targetUrl = process.env.DSH_E2E_DOCUMENT_URL
const workspacePath = process.env.DSH_E2E_WORKSPACE
const acceptedDocumentPath = process.env.DSH_E2E_DOCUMENT_PATH
const documentMarker = process.env.DSH_E2E_DOCUMENT_MARKER
const rejectedDocumentPath = process.env.DSH_E2E_REJECTED_DOCUMENT_PATH
const configured = [
  targetUrl,
  workspacePath,
  acceptedDocumentPath,
  documentMarker,
  rejectedDocumentPath,
].every(value => value !== undefined && value !== '')

async function ensureWorkspace(page: Page, path: string): Promise<void> {
  const composer = page.locator('textarea:enabled[placeholder="Describe what you want to build"]')
  if (await composer.count() > 0) return
  await page.getByRole('textbox', { name: 'Choose workspace' }).click()
  const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  const existingSelected = await Promise.any([
    composer.waitFor({ timeout: 10_000 }).then(() => true),
    dialog.waitFor({ timeout: 10_000 }).then(() => false),
  ])
  if (existingSelected) return
  await dialog.getByRole('button', { name: 'Edit path' }).click()
  const pathInput = dialog.getByRole('textbox', { name: 'Edit path' })
  await pathInput.fill(path)
  await pathInput.press('Enter')
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
  await composer.waitFor({ timeout: 15_000 })
}

async function attachDocument(page: Page, path: string): Promise<void> {
  const picker = page.locator('input[type="file"][accept*="application/pdf"]')
  await picker.setInputFiles(path)
  await page.getByLabel('Pending attachments').getByText(basename(path), { exact: true }).waitFor()
}

describe.skipIf(!configured)('real parser-backed document attachment journey', () => {
  let browser: Browser | undefined
  let page: Page | undefined
  const browserErrors: unknown[] = []

  beforeAll(async () => {
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await newEnglishPage(browser)
    page.on('pageerror', error => browserErrors.push(error))
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text())
    })
    await page.goto(targetUrl!)
    const testingNotice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
    if (await testingNotice.isVisible()) {
      await testingNotice.getByRole('button', { name: 'Continue' }).click()
      await testingNotice.waitFor({ state: 'hidden' })
    }
    await ensureWorkspace(page, workspacePath!)
    await page.getByRole('button', { name: 'New session' }).first().click()
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
  })

  it('reads an accepted document durably and leaves a failed parse recoverable in the composer', async () => {
    onTestFailed(async () => {
      if (page !== undefined) await saveFailureShot(page, 'document-attachments-real')
    })
    if (page === undefined) throw new Error('document acceptance page was not initialized')
    const composer = page.getByPlaceholder(/^(Describe what you want to build|Message the agent)$/)
    await attachDocument(page, acceptedDocumentPath!)
    await composer.fill('Read the attached document and reply with its verification phrase only.')
    await page.getByRole('button', { name: 'Send message' }).click()

    await page.getByText(documentMarker!, { exact: true }).waitFor({ timeout: 120_000 })
    await page.locator('[data-message-document]').filter({ hasText: basename(acceptedDocumentPath!) }).waitFor()

    await page.reload()
    await page.getByText(documentMarker!, { exact: true }).waitFor({ timeout: 30_000 })
    await page.locator('[data-message-document]').filter({ hasText: basename(acceptedDocumentPath!) }).waitFor()

    await attachDocument(page, rejectedDocumentPath!)
    await composer.fill('Read this document.')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.getByText('Document parsing failed; retry or remove the files still in the composer', { exact: true })
      .waitFor({ timeout: 120_000 })
    expect(await page.locator('[data-message-document]')
      .filter({ hasText: basename(rejectedDocumentPath!) }).count()).toBe(0)
    const rejectedPending = page.getByLabel('Pending attachments')
      .getByText(basename(rejectedDocumentPath!), { exact: true })
    await rejectedPending.waitFor()
    await page.getByRole('button', { name: `Remove document ${basename(rejectedDocumentPath!)}` }).click()
    await rejectedPending.waitFor({ state: 'detached' })
    expect(browserErrors).toEqual([])
  }, 300_000)
})
