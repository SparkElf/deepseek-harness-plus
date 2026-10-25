// @vitest-environment jsdom
/**
 * Publish-dialog visibility rules: admins see global/any-department; ordinary
 * users have no global option and are fixed to their own department; the last
 * choice is remembered per user; a backend 403 on global falls back to the
 * department choice instead of losing the dialog.
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
const original = globalThis.fetch
const originalUser = (window as { __DATAOPS_USER__?: unknown }).__DATAOPS_USER__

afterEach(() => {
  cleanup()
  globalThis.fetch = original
  ;(window as { __DATAOPS_USER__?: unknown }).__DATAOPS_USER__ = originalUser
  localStorage.clear()
  vi.restoreAllMocks()
})

interface Script {
  scope: Record<string, unknown>
  submitStatus?: number
}

function stubFetch(script: Script): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/dsh-skill-center/list')) {
      return new Response(JSON.stringify({
        cwd: '/ws', projectRoots: ['/ws'], complete: true,
        groups: [{ key: 'user-dsh', title: '用户', skills: [skill] }],
      }), { status: 200 })
    }
    if (url.includes('/api/dsh-skill-center/content')) {
      return new Response(JSON.stringify({ name: 'alpha', content: '# alpha\nbody' }), { status: 200 })
    }
    if (url.includes('/api/dsh-skill-center/translation-progress')) return new Response('{}', { status: 200 })
    if (url.includes('/integrations/dataops/review-context')) {
      return new Response(JSON.stringify(script.scope), { status: 200 })
    }
    if (url.includes('/integrations/dataops/rbac')) {
      return new Response(JSON.stringify({ items: [
        { code: 'D0', name: '总部', parentCode: null },
        { code: 'D1', name: '数据部', parentCode: 'D0' },
        { code: 'D2', name: '市场部', parentCode: 'D0' },
      ] }), { status: 200 })
    }
    if (url.includes('/integrations/dataops/skill-plaza')) {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'forbidden' }), { status: script.submitStatus ?? 201 })
      }
      return new Response(JSON.stringify({ skills: [] }), { status: 200 })
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
  render(<SkillCenterPage {...props} />)
}

async function openDialog(): Promise<void> {
  await waitFor(() => expect(screen.getAllByText('alpha').length).toBeGreaterThan(0))
  const share = [...document.querySelectorAll('button')].find(button => button.textContent === '上架')!
  fireEvent.click(share)
  await waitFor(() => expect(document.querySelector('[data-share-dialog]')).not.toBeNull())
}

describe('publish visibility', () => {
  it('admin defaults to global and can pick any department', async () => {
    stubFetch({ scope: { canReview: true, canReviewGlobal: true, departmentCode: 'D0', departmentPath: [{ code: 'D0', name: '总部' }] } })
    mount()
    await openDialog()
    const select = document.querySelector('[data-share-visibility]') as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('global'))
    expect([...select.options].map(option => option.value)).toEqual(['global', 'department', 'private'])
    fireEvent.change(select, { target: { value: 'department' } })
    const department = document.querySelector('[data-share-department]') as HTMLSelectElement
    expect([...department.options].map(option => option.value)).toEqual(['D0', 'D1', 'D2'])
    expect(department.disabled).toBe(false)
  })

  it('ordinary user has no global option and is fixed to their department', async () => {
    stubFetch({ scope: { canReview: false, canReviewGlobal: false, departmentCode: 'D1', departmentPath: [{ code: 'D1', name: '数据部' }] } })
    mount()
    await openDialog()
    const select = document.querySelector('[data-share-visibility]') as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('department'))
    expect([...select.options].map(option => option.value)).toEqual(['department', 'private'])
    const department = document.querySelector('[data-share-department]') as HTMLSelectElement
    expect([...department.options].map(option => option.value)).toEqual(['D1'])
    expect(department.disabled).toBe(true)
  })

  it('remembers the last choice per user', async () => {
    ;(window as { __DATAOPS_USER__?: unknown }).__DATAOPS_USER__ = { id: 'u1', username: 'admin', displayName: '超级管理员' }
    localStorage.setItem('dsh-skill-center:plaza-scope:u1', JSON.stringify({ visibility: 'private' }))
    stubFetch({ scope: { canReview: true, canReviewGlobal: true, departmentCode: 'D0' } })
    mount()
    await openDialog()
    const select = document.querySelector('[data-share-visibility]') as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('private'))
  })

  it('a global 403 falls back to the department choice with a readable error', async () => {
    stubFetch({ scope: { canReview: true, canReviewGlobal: true, departmentCode: 'D0' }, submitStatus: 403 })
    mount()
    await openDialog()
    fireEvent.change(document.querySelector('[data-share-visibility]')!, { target: { value: 'global' } })
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }))
    await waitFor(() => expect(screen.getByText(/无权选择该范围/)).toBeTruthy())
    expect((document.querySelector('[data-share-visibility]') as HTMLSelectElement).value).toBe('department')
  })
})
