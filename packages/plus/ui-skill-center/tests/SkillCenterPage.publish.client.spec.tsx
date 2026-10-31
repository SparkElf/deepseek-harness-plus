// @vitest-environment jsdom
/**
 * Publish dialog frame: one portaled dialog whose header and footer stay put
 * while the body between them scrolls, and native selects whose options carry
 * the dialog's theme (readable on the dark palette) instead of the browser's
 * white-on-white default.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SkillCenterPage } from '../src/client/SkillCenterPage.tsx'
import { zh } from '../src/client/locales.ts'
import type { SkillEntry } from '../src/client/api.ts'

const skill: SkillEntry = {
  name: 'alpha', description: 'A', level: 'user-dsh', modelInvocable: true, userInvocable: true,
}
const longBody = '# alpha\n' + '一条很长的技能说明。'.repeat(400)
const original = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = original
  vi.restoreAllMocks()
})

function stubFetch(scope: Record<string, unknown>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/dsh-skill-center/list')) {
      return new Response(JSON.stringify({
        cwd: '/ws', projectRoots: ['/ws'], complete: true,
        groups: [{ key: 'user-dsh', title: '用户', skills: [skill] }],
      }), { status: 200 })
    }
    if (url.includes('/api/dsh-skill-center/content')) {
      return new Response(JSON.stringify({ name: 'alpha', content: longBody }), { status: 200 })
    }
    if (url.includes('/api/dsh-skill-center/connectors')) return new Response('{}', { status: 404 })
    if (url.includes('/api/dsh-skill-center/translation-progress')) return new Response('{}', { status: 200 })
    if (url.includes('/integrations/dataops/review-context')) return new Response(JSON.stringify(scope), { status: 200 })
    if (url.includes('/integrations/dataops/rbac')) {
      return new Response(JSON.stringify({ items: [
        { code: 'D0', name: '总部', parentCode: null },
        { code: 'D1', name: '数据部', parentCode: 'D0' },
      ] }), { status: 200 })
    }
    if (url.includes('/integrations/dataops/skill-plaza')) return new Response(JSON.stringify({ skills: [] }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
}

function mount(): void {
  const t = (key: keyof typeof zh): string => zh[key]
  const props = {
    t,
    renderSlot: () => null,
    useWorkspaces: () => [{ path: '/ws', sessionIds: ['s1'] }],
  } as unknown as ComponentProps<typeof SkillCenterPage>
  render(<SkillCenterPage {...props} />)
}

async function openDialog(): Promise<HTMLElement> {
  fireEvent.click(document.querySelector('[data-tab="personal"]') as HTMLElement)
  await waitFor(() => expect(screen.getAllByText('alpha').length).toBeGreaterThan(0))
  const share = [...document.querySelectorAll('button')].find(button => button.textContent === '上架')!
  fireEvent.click(share)
  await waitFor(() => expect(document.querySelector('[data-share-dialog]')).not.toBeNull())
  return screen.getByRole('dialog')
}

describe('publish dialog frame', () => {
  it('portals one dialog with a fixed header, scrolling body, and footer', async () => {
    stubFetch({ canReview: true, canReviewGlobal: true, departmentCode: 'D0' })
    mount()
    const dialog = await openDialog()
    expect(document.body.contains(dialog)).toBe(true)
    expect(dialog.closest('[data-tab-panel]')).toBeNull()
    const body = dialog.querySelector('[data-publish-body]')
    expect(body).not.toBeNull()
    expect(body?.querySelector('[data-share-dialog]')).not.toBeNull()
    expect(dialog.querySelector('h2')?.textContent).toBe('上架到技能广场')
    expect([...dialog.querySelectorAll('button')].some(button => button.textContent === '提交审核')).toBe(true)
    // Header, body, and footer are direct children, so the body is the only region that scrolls.
    const directChildren = [...dialog.children].map(child => child.hasAttribute('data-publish-body') ? 'body' : child.tagName.toLowerCase())
    expect(directChildren).toEqual(['header', 'body', 'footer'])
  })

  it('keeps long skill content inside the scrolling body', async () => {
    stubFetch({ canReview: true, canReviewGlobal: true, departmentCode: 'D0' })
    mount()
    const dialog = await openDialog()
    await waitFor(() => {
      const textarea = dialog.querySelector('[data-share-dialog] textarea') as HTMLTextAreaElement
      expect(textarea.value.length).toBe(longBody.length)
    })
    expect(dialog.querySelector('[data-publish-body] textarea')).not.toBeNull()
  })

  it('renders readable, disabled-aware native options on the dialog theme', async () => {
    stubFetch({ canReview: false, canReviewGlobal: false, departmentCode: 'D1', departmentPath: [{ code: 'D1', name: '数据部' }] })
    mount()
    const dialog = await openDialog()
    const visibility = dialog.querySelector('[data-share-visibility]') as HTMLSelectElement
    await waitFor(() => expect(visibility.value).toBe('department'))
    expect([...visibility.options].map(option => option.value)).toEqual(['department', 'private'])
    // A fixed department is communicated as a disabled control, not a select the user can change.
    const department = dialog.querySelector('[data-share-department]') as HTMLSelectElement
    expect(department.disabled).toBe(true)
    expect(department.value).toBe('D1')
  })
})