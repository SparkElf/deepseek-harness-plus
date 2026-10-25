// @vitest-environment jsdom
/**
 * Local skill cards render the plaza's review state and the matching action:
 * local -> 上架, pending -> 待审核 + 取消共享, approved -> 已上架 + 已共享,
 * rejected -> 已驳回 + 重新提交. A 503 shows the not-ready banner and disables
 * publishing rather than inventing a status.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { SkillCenterPage } from '../src/client/SkillCenterPage.tsx'
import { zh } from '../src/client/locales.ts'
import type { SkillEntry } from '../src/client/api.ts'

const skills: SkillEntry[] = [
  { name: 'alpha', description: 'A', level: 'user-dsh', modelInvocable: true, userInvocable: true },
  { name: 'beta', description: 'B', level: 'user-dsh', modelInvocable: true, userInvocable: true },
  { name: 'gamma', description: 'C', level: 'user-dsh', modelInvocable: true, userInvocable: true },
  { name: 'delta', description: 'D', level: 'user-dsh', modelInvocable: true, userInvocable: true },
]

const plazaRows = [
  { id: 1, name: 'alpha', reviewStatus: 'approved', sharedByMe: true },
  { id: 2, name: 'beta', reviewStatus: 'pending', sharedByMe: true },
  { id: 3, name: 'gamma', reviewStatus: 'rejected', sharedByMe: true, reviewNote: '需要示例' },
]

const original = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = original
  vi.restoreAllMocks()
})

function stubFetch(plazaStatus = 200): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/dsh-skill-center/list')) {
      return new Response(JSON.stringify({
        cwd: '/ws', projectRoots: ['/ws'], complete: true,
        groups: [{ key: 'user-dsh', title: '用户 ~/.dsh/skills', skills }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/dsh-skill-center/translation-progress')) return new Response('{}', { status: 200 })
    if (url.includes('/integrations/dataops/skill-plaza')) {
      return new Response(JSON.stringify(plazaStatus === 503 ? { error: 'not active' } : { skills: plazaRows }), { status: plazaStatus })
    }
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
  render(
    <SkillCenterPage {...props} />,
  )
}

describe('SkillCenterPage plaza cards', () => {
  it('shows local/pending/approved/rejected with the right actions', async () => {
    stubFetch()
    mount()
    await waitFor(() => expect(screen.getAllByText('alpha').length).toBeGreaterThan(0))
    const card = (name: string) => document.querySelector(`[data-skill-name="${name}"]`) as HTMLElement
    expect(card('alpha').dataset.plazaStatus).toBe('approved')
    expect(card('alpha').textContent).toContain('已上架')
    expect(card('alpha').querySelector('[data-plaza-shared]')?.textContent).toBe('已共享')
    expect(card('alpha').textContent).toContain('取消共享')
    expect(card('beta').dataset.plazaStatus).toBe('pending')
    expect(card('beta').textContent).toContain('待审核')
    expect(card('gamma').dataset.plazaStatus).toBe('rejected')
    expect(card('gamma').textContent).toContain('已驳回')
    expect(card('gamma').textContent).toContain('重新提交')
    expect(card('delta').dataset.plazaStatus).toBe('local')
    expect(card('delta').textContent).toContain('上架')
  })

  it('disables publishing and shows the not-ready banner on 503', async () => {
    stubFetch(503)
    mount()
    await waitFor(() => expect(screen.getByText(/共享服务未就绪/)).toBeTruthy())
    expect(document.querySelectorAll('[data-skill-name][data-plaza-status="local"]').length).toBe(4)
    const delta = document.querySelector('[data-skill-name="delta"]') as HTMLElement
    const share = [...delta.querySelectorAll('button')].find(button => button.textContent === '上架')!
    expect(share.hasAttribute('disabled')).toBe(true)
  })
})
