// Web acceptance for current sandbox-policy context. A real Chromium drives
// the shipped /permission command through all three presets; record mode uses
// the real provider, while replay keeps the same provider-authored behavior
// keyless. Assertions read the exact durable header, runtime-context messages,
// and tool calls, so assistant prose alone cannot satisfy the scenario.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFinalWorkspaceSnapshot, assertFixtureInventory, fixtureUserPrompts, launchWebScaffold, recordFixture,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/permission-policy-context', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/permission-policy-context/session.v2.jsonl', import.meta.url))
const MODE = webSnapshotMode()

const PROMPTS = [
  'Can you create or edit a normal file right now under the current policy? Answer directly in one sentence. Do not call a tool just to discover the policy.',
  'Does the DSH file sandbox currently restrict file operations? Answer directly in one sentence. Do not call tools.',
  'Reply with exactly WORKSPACE_POLICY_SEEN. Do not call tools.',
  'Create the relative path policy-neutral.txt in the current workspace containing exactly POLICY_NEUTRAL_OK, verify its contents, then report completion.',
] as const

const PRESET_LABELS = ['Read Only', 'Full access', 'Workspace Write'] as const

function requestSystems(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== 'request/header') return []
    return typeof event.data.header.system === 'string' ? [event.data.header.system] : []
  })
}

function runtimeContexts(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== '@deepseek-ai/dsh-system-prompt') return []
    return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
  })
}

function assistantTexts(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== 'assistant/message') return []
    const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').replaceAll('**', '')
    return text.length === 0 ? [] : [text]
  })
}

function callArgs(event: Extract<SessionEvent, { type: 'tool/call' }>): Record<string, unknown> {
  return JSON.parse(event.data.arguments) as Record<string, unknown>
}

describe('web e2e: current sandbox policy reaches the model before tools', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let disposeApproval: (() => void) | undefined
  let sessionWorkspace: string | undefined
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold(MODE === 'record' ? {} : { replayFixture: FIXTURE, compareReplaySession: true })
    disposeApproval = scaffold.ctx.on('approval/request', () => Promise.resolve('allowed-once'), { prepend: true })
    scaffold.ctx.on('session/event', (session, event: SessionEvent) => {
      sessionWorkspace = session.header.cwd
      sessionEvents.push(event)
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    disposeApproval?.()
    await scaffold?.close()
  })


  it('preserves the desktop menu and uses a compact viewport portal on phones', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-permission-menu-responsive'))
    const trigger = page.locator('[data-permission-trigger]')
    await trigger.waitFor({ timeout: 10_000 })
    const measure = async (width: number) => {
      await page.setViewportSize({ width, height: 820 })
      await page.waitForTimeout(300)
      await trigger.click()
      const menu = page.getByRole('menu')
      await menu.waitFor()
      const box = await menu.boundingBox()
      if (box === null) throw new Error('permission menu has no layout box')
      const rows = await menu.getByRole('menuitem').evaluateAll(nodes => nodes.map(node => ({
        height: node.getBoundingClientRect().height,
        fontSize: getComputedStyle(node).fontSize,
      })))
      const parentBody = await menu.evaluate(element => element.parentElement === document.body)
      await page.keyboard.press('Escape')
      return { box, rows, parentBody }
    }

    const desktop = await measure(1000)
    expect(desktop).toMatchObject({ parentBody: false, box: { width: 218, height: 130 } })
    expect(desktop.rows).toEqual(Array.from({ length: 3 }, () => ({ height: 40, fontSize: '14px' })))

    const card = page.locator('[data-composer-card]')
    await card.evaluate((element) => {
      element.style.width = '300px'
      element.style.maxWidth = '300px'
    })
    await page.waitForTimeout(300)
    const constrainedDesktop = await measure(1000)
    expect(constrainedDesktop).toMatchObject({ parentBody: true, box: { width: 164, height: 84 } })
    expect(constrainedDesktop.box.x).toBeGreaterThanOrEqual(12)
    expect(constrainedDesktop.box.x + constrainedDesktop.box.width).toBeLessThanOrEqual(988)
    await card.evaluate((element) => {
      element.style.removeProperty('width')
      element.style.removeProperty('max-width')
    })

    for (const width of [418, 320]) {
      const mobile = await measure(width)
      expect(mobile).toMatchObject({ parentBody: true, box: { width: 164, height: 84 } })
      expect(mobile.rows).toEqual(Array.from({ length: 3 }, () => ({ height: 26, fontSize: '12px' })))
      expect(mobile.box.x).toBeGreaterThanOrEqual(12)
      expect(mobile.box.x + mobile.box.width).toBeLessThanOrEqual(width - 12)
    }
    await page.setViewportSize({ width: 1280, height: 820 })
  }, 60_000)

  it('switches read-only, danger-full-access, and workspace-write through the real GUI command path', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-permission-policy-context'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual(PROMPTS)
    }

    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    let sessionId: Awaited<ReturnType<WebScaffold['whenTurnSettled']>> | undefined
    for (const [index, preset] of ['read-only', 'danger-full-access', 'workspace-write'].entries()) {
      await writeComposerDraft(page, input, `/permission ${preset}`)
      await input.press('Enter')
      await page.getByRole('button', { name: `Access mode, current: ${PRESET_LABELS[index]}` })
        .waitFor({ timeout: 10_000 })

      const settled = scaffold.whenTurnSettled()
      await writeComposerDraft(page, input, PROMPTS[index] as string)
      await input.press('Enter')
      sessionId = await settled
      await input.waitFor({ timeout: 10_000 })
    }

    await writeComposerDraft(page, input, '/permission read-only')
    await input.press('Enter')
    await page.getByRole('button', { name: 'Access mode, current: Read Only' }).waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled()
    await writeComposerDraft(page, input, PROMPTS[3])
    await input.press('Enter')
    sessionId = await settled

    if (sessionId === undefined) throw new Error('permission-policy scenario completed no model turn')
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)
    if (sessionWorkspace === undefined) throw new Error('permission-policy scenario observed no session workspace')
    await assertFinalWorkspaceSnapshot(SNAPSHOT_DIR, sessionWorkspace)
  }, 240_000)

  it.skipIf(MODE === 'record')('records cache-safe current policy before the corresponding model behavior', async () => {
    const systems = requestSystems(sessionEvents)
    expect(systems).toHaveLength(1)
    expect(systems[0]).not.toContain('Current DSH file policy:')
    expect(systems[0]).not.toContain('Approval policy:')
    expect(systems[0]).not.toContain('Approval prompts are disabled in this session')

    const contexts = runtimeContexts(sessionEvents)
    expect(contexts).toHaveLength(4)
    expect(contexts[0]).toContain('Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode.')
    expect(contexts[0]).toContain('Do not refuse a required modification from this policy alone')
    expect(contexts[0]).toContain('Approval policy: ask.')
    expect(contexts[1]).toContain('Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.')
    expect(contexts[1]).toContain('Approval prompts are disabled in this session')

    if (sessionWorkspace === undefined) throw new Error('permission-policy scenario observed no session workspace')
    expect(contexts[2]).toContain(`Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(canonicalPath(sessionWorkspace))}. Some platform temporary areas may also be writable.`)
    expect(contexts[2]).toContain('Approval policy: ask.')
    expect(contexts[2]).not.toContain('Approval prompts are disabled in this session')
    expect(contexts[3]).toContain('Current DSH file policy: read-only.')

    const answers = assistantTexts(sessionEvents)
    expect(answers.length).toBeGreaterThanOrEqual(4)
    expect(answers[0]).toMatch(/read-only.*(?:denied|cannot modify|cannot create or edit)/i)
    expect(answers[1]).toMatch(/does not restrict.*(?:file operations|(?:write\/edit tools|write and edit tools).*one-shot bash commands)/i)
    expect(answers[2]).toBe('WORKSPACE_POLICY_SEEN')
    const calls = sessionEvents.filter(
      (event): event is Extract<SessionEvent, { type: 'tool/call' }> => event.type === 'tool/call',
    )
    expect(calls.every(call => call.data.turn === 4)).toBe(true)
    expect(calls.length).toBeGreaterThanOrEqual(2)
    const firstCall = calls[0]
    if (firstCall === undefined) throw new Error('neutral policy task produced no tool call')
    expect(callArgs(firstCall)['sandbox_permissions']).toBeUndefined()
    expect(calls.some(call => callArgs(call)['sandbox_permissions'] !== undefined)).toBe(true)
    expect(sessionEvents.some(event => event.type === 'tool/result'
      && JSON.stringify(event.data).includes('[sandbox: file access denied under read-only mode]'))).toBe(true)
    expect(sessionEvents.some(event => event.type === 'approval/asked')).toBe(true)
    if (sessionWorkspace === undefined) throw new Error('permission-policy scenario observed no session workspace')
    expect(await readFile(join(sessionWorkspace, 'policy-neutral.txt'), 'utf8')).toBe('POLICY_NEUTRAL_OK')
  })

  it.skipIf(MODE === 'record')('stays clean and keeps the fixture inventory closed', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v2.jsonl', 'workspace.expected'])
  })
})
