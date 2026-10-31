// @vitest-environment jsdom
/**
 * The page's four top-level tabs: bundled skills under 内置, every local,
 * project, shared, or submitted skill under 个人, the contributed plaza under
 * 技能广场, and the connector catalogue under 连接器. The connector tab hides a
 * capability the account may not use entirely rather than rendering it
 * disabled, and each visible capability toggles independently.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SkillCenterPage } from '../src/client/SkillCenterPage.tsx'
import { zh } from '../src/client/locales.ts'
import type { SkillEntry } from '../src/client/api.ts'

const bundled: SkillEntry = {
  name: 'bundled-alpha', description: 'Bundled A', level: 'bundled', modelInvocable: true, userInvocable: true,
}
const personal = [
  { name: 'user-alpha', description: 'User A', level: 'user-dsh', modelInvocable: true, userInvocable: true },
  { name: 'project-beta', description: 'Project B', level: 'project-dsh', modelInvocable: true, userInvocable: true },
] satisfies SkillEntry[]

const original = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = original
  vi.restoreAllMocks()
})

function stubFetch(): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/dsh-skill-center/list')) {
      return new Response(JSON.stringify({
        cwd: '/ws', projectRoots: ['/ws'], complete: true,
        groups: [
          { key: 'bundled', title: '系统内置', skills: [bundled] },
          { key: 'user-dsh', title: '用户 ~/.dsh/skills', skills: [personal[0]] },
          { key: 'project-dsh', title: '项目 .dsh/skills', skills: [personal[1]] },
        ],
      }), { status: 200 })
    }
    if (url.includes('/api/dsh-skill-center/connectors')) {
      // No bridge route in this profile: the tab must fall back to the demo rows.
      return new Response('{}', { status: 404 })
    }
    if (url.includes('/api/dsh-skill-center/translation-progress')) return new Response('{}', { status: 200 })
    if (url.includes('/integrations/dataops/review-context')) return new Response('{}', { status: 200 })
    if (url.includes('/integrations/dataops/skill-plaza')) return new Response(JSON.stringify({ skills: [] }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
}

function mount(overrides: Partial<ComponentProps<typeof SkillCenterPage>> = {}): void {
  const t = (key: keyof typeof zh): string => zh[key]
  const props = {
    t,
    renderSlot: (key: string, _owner: unknown, opts?: { fallback?: React.ReactNode }) =>
      key === 'skill-center.section' ? <div data-plaza-contribution /> : opts?.fallback ?? null,
    useWorkspaces: () => [{ path: '/ws', sessionIds: ['s1'] }],
    ...overrides,
  } as unknown as ComponentProps<typeof SkillCenterPage>
  render(<SkillCenterPage {...props} />)
}

function tab(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find(candidate => candidate.textContent?.startsWith(label))
  if (match === undefined) throw new Error('tab not found: ' + label)
  return match
}

describe('skill center tabs', () => {
  it('opens on 内置 and classifies bundled skills apart from personal ones', async () => {
    stubFetch()
    mount()
    await waitFor(() => expect(screen.getAllByText('bundled-alpha').length).toBeGreaterThan(0))
    expect([...document.querySelectorAll('[role="tab"]')].map(node => node.textContent?.replace(/\d+$/u, ''))).toEqual([
      '内置', '个人', '技能广场', '连接器',
    ])
    expect(tab('内置').getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('[data-skill-name="bundled-alpha"]')).not.toBeNull()
    expect(document.querySelector('[data-skill-name="user-alpha"]')).toBeNull()
    expect(document.querySelector('[data-skill-name="project-beta"]')).toBeNull()
  })

  it('moves every non-bundled group to 个人', async () => {
    stubFetch()
    mount()
    await waitFor(() => expect(screen.getAllByText('bundled-alpha').length).toBeGreaterThan(0))
    fireEvent.click(tab('个人'))
    expect(tab('个人').getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('[data-skill-name="bundled-alpha"]')).toBeNull()
    expect(document.querySelector('[data-skill-name="user-alpha"]')).not.toBeNull()
    expect(document.querySelector('[data-skill-name="project-beta"]')).not.toBeNull()
  })

  it('renders the contributed plaza only inside 技能广场', async () => {
    stubFetch()
    mount()
    await waitFor(() => expect(screen.getAllByText('bundled-alpha').length).toBeGreaterThan(0))
    expect(document.querySelector('[data-plaza-contribution]')).toBeNull()
    fireEvent.click(tab('技能广场'))
    expect(document.querySelector('[data-tab-panel="plaza"] [data-plaza-contribution]')).not.toBeNull()
  })

  it('searches skills in the active tab and switches the connector placeholder', async () => {
    stubFetch()
    mount()
    await waitFor(() => expect(screen.getAllByText('bundled-alpha').length).toBeGreaterThan(0))
    const search = screen.getByRole('searchbox')
    expect(search.getAttribute('placeholder')).toBe('搜索技能…')
    fireEvent.change(search, { target: { value: 'nothing' } })
    expect(await screen.findByText('无匹配技能')).toBeTruthy()
    fireEvent.click(tab('连接器'))
    expect(screen.getByRole('searchbox').getAttribute('placeholder')).toBe('搜索连接器…')
  })
})

describe('connector tab', () => {
  it('shows the demo catalogue with the named connector and hides capabilities while disabled', async () => {
    stubFetch()
    mount()
    await waitFor(() => expect(screen.getAllByText('bundled-alpha').length).toBeGreaterThan(0))
    fireEvent.click(tab('连接器'))
    await waitFor(() => expect(document.querySelector('[data-connector-id="wanxiang-ai"]')).not.toBeNull())
    const card = document.querySelector('[data-connector-id="wanxiang-ai"]') as HTMLElement
    expect(card.textContent).toContain('万相AI中台连接器')
    expect(card.getAttribute('data-connector-enabled')).toBe('false')
    expect(card.querySelector('[data-connector-capabilities]')).toBeNull()
    expect(document.querySelector('[data-connector-id="work-order"]')).not.toBeNull()
    expect(document.querySelector('[data-connector-catalogue]')?.getAttribute('data-demo')).toBe('true')
  })

  it('reveals only permitted capabilities when enabled and shows unavailable reasons', async () => {
    stubFetch()
    mount()
    await waitFor(() => expect(screen.getAllByText('bundled-alpha').length).toBeGreaterThan(0))
    fireEvent.click(tab('连接器'))
    await waitFor(() => expect(document.querySelector('[data-connector-id="wanxiang-ai"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('switch', { name: '启用 万相AI中台连接器' }))
    await waitFor(() => {
      expect(document.querySelector('[data-connector-id="wanxiang-ai"] [data-connector-capabilities]')).not.toBeNull()
    })
    const card = document.querySelector('[data-connector-id="wanxiang-ai"]') as HTMLElement
    expect(card.querySelector('[data-capability-id="approval.read"]')).not.toBeNull()
    // This account has no permission for the credential capability: it is absent, not disabled.
    expect(card.querySelector('[data-capability-id="credential.manage"]')).toBeNull()
    expect(card.querySelector('[data-capability-id="approval.batch"]')?.textContent).toContain('当前连接未开通批量接口')
    const batchSwitch = [...card.querySelectorAll('[role="switch"]')]
      .find(node => node.getAttribute('aria-label') === '启用 批量审批') as HTMLButtonElement
    expect(batchSwitch.disabled).toBe(true)
  })

  it('toggles one capability without changing its siblings', async () => {
    stubFetch()
    mount()
    await waitFor(() => expect(screen.getAllByText('bundled-alpha').length).toBeGreaterThan(0))
    fireEvent.click(tab('连接器'))
    await waitFor(() => expect(document.querySelector('[data-connector-id="wanxiang-ai"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('switch', { name: '启用 万相AI中台连接器' }))
    await waitFor(() => expect(document.querySelector('[data-capability-id="task.writeback"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('switch', { name: '启用 回写任务状态' }))
    await waitFor(() => {
      expect(document.querySelector('[data-capability-id="task.writeback"]')?.getAttribute('data-capability-enabled')).toBe('true')
    })
    expect(document.querySelector('[data-capability-id="approval.read"]')?.getAttribute('data-capability-enabled')).toBe('true')
    expect(document.querySelector('[data-capability-id="approval.handle"]')?.getAttribute('data-capability-enabled')).toBe('true')
  })
})