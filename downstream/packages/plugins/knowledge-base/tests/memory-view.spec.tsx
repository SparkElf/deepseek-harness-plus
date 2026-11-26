/**
 * The memory page's product contract.
 *
 * The table and dialogs are rendered from an explicit snapshot, so the test can
 * assert the six fixed columns, the last-column actions, the confirmation copy and
 * the two empty states without mounting a fetch lifecycle. A source-shape check
 * covers the two things a server render cannot: the panel menu entry and the fact
 * that only `confirmToggle` ever calls `memory.set-enabled`.
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { zh } from '../src/client/locales.ts'
import type { KnowledgeMemoryViewProps, MemoryEntryView } from '../src/client/KnowledgeMemory.tsx'

// The primitives package imports CSS at module scope; these stand-ins keep the
// renderer focused on the memory markup rather than the host component library.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Button = (props: { children?: unknown; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={props.onClick} disabled={props.disabled}>{props.children as never}</button>
  )
  const Input = (props: { value?: string; onChange?: (event: { target: { value: string } }) => void; placeholder?: string; className?: string; 'aria-label'?: string }) => (
    <input
      className={props.className}
      value={props.value}
      placeholder={props.placeholder}
      aria-label={props['aria-label']}
      onChange={props.onChange as never}
    />
  )
  const Switch = (props: { checked?: boolean; disabled?: boolean; onChange?: (next: boolean) => void; label?: string }) => (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked === true}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => { props.onChange?.(props.checked !== true) }}
    />
  )
  const Modal = (props: { open?: boolean; title?: string; children?: unknown; footer?: unknown; closeLabel?: string }) => (
    props.open === true
      ? (
        <div role="dialog" aria-label={props.title}>
          <h2>{props.title}</h2>
          <div>{props.children as never}</div>
          <div data-testid="modal-footer">{props.footer as never}</div>
        </div>
        )
      : null
  )
  return { __esModule: true, Button, Input, Switch, Modal }
})

const { KnowledgeMemoryView } = await import('../src/client/KnowledgeMemory.tsx')

const t = (key: string): string => (zh as Record<string, string>)[key] ?? key
const now = Date.now()
const iso = (daysAgo: number): string => new Date(now - daysAgo * 86_400_000).toISOString()

const entries: MemoryEntryView[] = [
  {
    id: 'm-preference',
    title: '结论先行',
    content: '回答先说结论，再展开细节。',
    type: 'preference',
    privacy: 'private',
    updatedAt: iso(2),
    source: { label: '驾驶舱下钻', at: iso(2), sessionId: 'session-dcf91e5c-secret', eventSeqs: [3, 8] },
  },
  {
    id: 'm-pitfall',
    title: '文件写入路径错误',
    content: '写入前先确认目录存在。',
    type: 'pitfall',
    privacy: 'normal',
    updatedAt: iso(1),
    source: { label: '历史会话', at: iso(1), sessionId: 'session-abc-123' },
  },
  {
    id: 'm-fact',
    title: '指标口径先查上游',
    content: '口径冲突时以上游表定义为准。',
    type: 'fact',
    privacy: 'sensitive',
    updatedAt: iso(3),
    sourceRefs: [
      { label: '指标排查', at: iso(3), sessionId: 'session-def-456' },
      { label: '驾驶舱下钻', at: iso(4), sessionId: 'session-ghi-789' },
    ],
  },
  {
    id: 'm-sop',
    title: '发布前核对回滚点',
    content: '每次发布前确认回滚点和窗口。',
    type: 'sop',
    privacy: 'secret',
    updatedAt: new Date(now - 5 * 3_600_000).toISOString(),
    source: { label: '发布检查', at: iso(1) },
  },
]

function baseProps(overrides: Partial<KnowledgeMemoryViewProps> = {}): KnowledgeMemoryViewProps {
  return {
    t,
    locale: 'zh-CN',
    enabled: false,
    settingsLoading: false,
    consolidationIntervalMinutes: 60,
    intervalMin: 15,
    intervalMax: 1440,
    intervalDraft: '60',
    intervalBusy: false,
    intervalSaved: false,
    onIntervalDraftChange: () => undefined,
    onSaveInterval: () => undefined,
    list: { status: 'ready', entries },
    query: '',
    typeFilter: '',
    onQueryChange: () => undefined,
    onTypeFilterChange: () => undefined,
    onToggleRequest: () => undefined,
    toggleBusy: false,
    onCancelToggle: () => undefined,
    onConfirmToggle: () => undefined,
    detailLoading: false,
    onOpenDetail: () => undefined,
    onCloseDetail: () => undefined,
    editBusy: false,
    onEditContent: () => undefined,
    onStartEdit: () => undefined,
    onCancelEdit: () => undefined,
    onSaveEdit: () => undefined,
    forgetBusy: false,
    onStartForget: () => undefined,
    onCancelForget: () => undefined,
    onConfirmForget: () => undefined,
    onRetrySettings: () => undefined,
    onRetryList: () => undefined,
    ...overrides,
  }
}

function render(overrides: Partial<KnowledgeMemoryViewProps> = {}): string {
  return renderToStaticMarkup(<KnowledgeMemoryView {...baseProps(overrides)} />)
}

/** The cells of the first table row, in document order. */
function firstRowCells(html: string): string[] {
  const start = html.indexOf('data-testid="memory-row"')
  if (start < 0) return []
  const row = html.slice(start, html.indexOf('</tr>', start))
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(match => match[1] ?? '')
}

describe('memory table', () => {
  it('renders exactly the six fixed columns, with actions last', () => {
    const html = render()
    const headers = [...html.matchAll(/<th(?:\s[^>]*)?>([\s\S]*?)<\/th>/g)].map(match => match[1])
    expect(headers).toEqual(['记忆', '类型', '来源', '更新时间', '隐私', '操作'])

    const cells = firstRowCells(html)
    expect(cells).toHaveLength(6)
    expect(cells[0]).toContain('结论先行')
    expect(cells[1]).toContain('偏好')
    expect(cells[2]).toContain('驾驶舱下钻')
    expect(cells[4]).toContain('仅自己')
    expect(cells[5]).toContain('查看')
    expect(cells[5]).toContain('纠正')
    expect(cells[5]).toContain('忘记')
    // The privacy chip belongs to the fifth column, not to the action column.
    expect(cells[5]).not.toContain('仅自己')
  })

  it('never puts a raw session id or tool name in a row', () => {
    const html = render()
    expect(html).not.toContain('session-dcf91e5c-secret')
    expect(html).not.toContain('session-abc-123')
    expect(html).not.toContain('eventSeqs')
    expect(html).not.toContain('kb_search')
    expect(html).toContain('驾驶舱下钻')
  })

  it('renders the list-row sourceLabel/sourceTime shape from the memory route', () => {
    const html = render({
      list: {
        status: 'ready',
        entries: [{
          id: 'm-flat',
          title: '测试来源',
          type: 'preference',
          privacy: 'private',
          updatedAt: iso(1),
          sourceLabel: '指标排查',
          sourceTime: iso(2),
        }],
      },
    })
    expect(html).toContain('指标排查')
    expect(html).toContain('2 天前')
  })

  it('filters by search term and by type', () => {
    expect((render({ query: '结论' }).match(/data-testid="memory-row"/g) ?? [])).toHaveLength(1)
    expect((render({ typeFilter: 'pitfall' }).match(/data-testid="memory-row"/g) ?? [])).toHaveLength(1)
    expect(render({ typeFilter: 'pitfall' })).toContain('文件写入路径错误')
    expect(render({ typeFilter: 'pitfall' })).not.toContain('结论先行')
    expect(render({ query: '没有这个' })).toContain('没有匹配的记忆。')
  })

  it('shows the paused state and the empty state by default', () => {
    const html = render({ enabled: false })
    expect(html).toContain('暂停')
    expect(html).toContain('记忆已暂停')
    const empty = render({ list: { status: 'ready', entries: [] } })
    expect(empty).toContain('还没有记忆')
  })

  it('renders the consolidation interval with the saved value and bounds', () => {
    const html = render({ consolidationIntervalMinutes: 30, intervalDraft: '30' })
    expect(html).toContain('data-testid="memory-interval"')
    expect(html).toContain('整理间隔')
    expect(html).toContain('15–1440')
    expect(html).toContain('value="30"')
    expect(html).toContain('保存')
    expect(html).toContain('data-saved-minutes="30"')
  })

  it('shows an interval validation error', () => {
    const html = render({ intervalError: '请输入 15–1440 之间的整数分钟。' })
    expect(html).toContain('请输入 15–1440 之间的整数分钟。')
  })

  it('shows loading and error states', () => {
    expect(render({ list: { status: 'loading', entries: [] } })).toContain('正在读取记忆')
    const failed = render({ list: { status: 'error', entries: [], error: 'offline' } })
    expect(failed).toContain('记忆读取失败')
    expect(failed).toContain('重试')
  })
})

describe('memory confirmations', () => {
  it('shows the enable explanation and confirm label when turning memory on', () => {
    const html = render({ enabled: false, pendingEnabled: true })
    expect(html).toContain('开启记忆')
    expect(html).toContain('会从会话中学习偏好、事实、踩坑和方法')
    expect(html).toContain('确认开启')
    expect(html).toContain('取消')
  })

  it('shows the pause explanation and confirm label when turning memory off', () => {
    const html = render({ enabled: true, pendingEnabled: false })
    expect(html).toContain('暂停记忆')
    expect(html).toContain('暂停后不再学习新记忆，已有记忆保留')
    expect(html).toContain('确认暂停')
  })

  it('only applies the switch in confirmToggle', async () => {
    const source = await readFile(new URL('../src/client/KnowledgeMemory.tsx', import.meta.url), 'utf8')
    const request = source.slice(source.indexOf('const requestToggle'), source.indexOf('const confirmToggle'))
    const confirm = source.slice(source.indexOf('const confirmToggle'), source.indexOf('const startEdit'))
    expect(request).toContain('setPendingEnabled(next)')
    expect(request).not.toContain('memory.set-enabled')
    expect(confirm).toContain("memoryRequest('memory.set-enabled'")
  })

  it('validates and persists the interval through one save-settings call', async () => {
    const source = await readFile(new URL('../src/client/KnowledgeMemory.tsx', import.meta.url), 'utf8')
    const save = source.slice(source.indexOf('const saveInterval'), source.indexOf('const startEdit'))
    expect(save).toContain("t('memoryIntervalInvalid')")
    expect(save).toContain("memoryRequest('memory.save-settings'")
    expect(save).toContain('consolidationIntervalMinutes: parsed')
    // The toggle path must not silently save a half-edited interval.
    const confirm = source.slice(source.indexOf('const confirmToggle'), source.indexOf('const saveInterval'))
    expect(confirm).toContain("memoryRequest('memory.set-enabled', { enabled: target })")
    expect(confirm).not.toContain('consolidationIntervalMinutes:')
  })
})

describe('memory detail', () => {
  it('renders content, source and the original link when the source resolves', () => {
    const html = render({ detail: entries[0], onOpenSource: () => undefined })
    expect(html).toContain('回答先说结论，再展开细节。')
    expect(html).toContain('偏好 · 仅自己')
    expect(html).toContain('驾驶舱下钻')
    expect(html).toContain('查看原文')
    expect(html).not.toContain('session-dcf91e5c-secret')
  })

  it('hides the original link when no source handler is mounted', () => {
    const html = render({ detail: entries[0] })
    expect(html).not.toContain('查看原文')
  })

  it('lists every merged source in the detail', () => {
    const html = render({ detail: entries[2], onOpenSource: () => undefined })
    expect(html).toContain('指标排查')
    expect(html).toContain('驾驶舱下钻')
  })
})

describe('panel integration source shape', () => {
  it('offers the memory menu between Home and Trash and renders the page', async () => {
    const source = await readFile(new URL('../src/client/KnowledgePanel.tsx', import.meta.url), 'utf8')
    const sections = source.slice(source.indexOf('const SECTIONS'), source.indexOf('const rendered'))
    const home = sections.indexOf("kind: 'home'")
    const memory = sections.indexOf("kind: 'memory'")
    const trash = sections.indexOf("kind: 'trash'")
    expect(home).toBeGreaterThanOrEqual(0)
    expect(memory).toBeGreaterThan(home)
    expect(trash).toBeGreaterThan(memory)
    expect(source).toContain('rendered.kind === \'memory\' && (')
    expect(source).toContain('<KnowledgeMemory')
    expect(source).toContain("if (selection.kind === 'memory') return t('menu.memory')")
  })
})
describe('memory promotion surface', () => {
  const basePromotion = {
    promotions: [{
      id: 'mp-1',
      memoryId: 'm-pitfall',
      title: '文件写入路径错误',
      type: 'pitfall',
      status: 'pending' as const,
      targetScope: 'department' as const,
      departmentCode: 'dept-a',
      requestedAt: iso(1),
    }],
    reviewQueue: [],
    shared: [],
    canPromoteGlobal: false,
    canPromoteDepartments: ['dept-a'],
    canReview: false,
    busy: false,
  }

  const actions = {
    onStart: () => undefined,
    onCancel: () => undefined,
    onScopeChange: () => undefined,
    onConfirmChange: () => undefined,
    onSubmit: () => undefined,
    onReview: () => undefined,
  }

  it('shows the review status next to the memory without changing the six columns', () => {
    const html = render({ promotion: basePromotion, promotionActions: actions })
    const headers = [...html.matchAll(/<th(?:\s[^>]*)?>([\s\S]*?)<\/th>/g)].map(match => match[1])
    expect(headers).toEqual(['记忆', '类型', '来源', '更新时间', '隐私', '操作'])
    expect(html).toContain('待审核')
    // Only the promotable (normal privacy) row offers the action.
    expect(html).toContain('晋升')
    expect(html).toMatch(/data-testid="memory-row"[\s\S]*?结论先行[\s\S]*?<\/tr>/u)
    const privateRow = html.slice(html.indexOf('结论先行'), html.indexOf('文件写入路径错误'))
    expect(privateRow).not.toContain('晋升')
  })

  it('hides the promote action from a member who cannot review', () => {
    const html = render({ promotion: basePromotion, promotionActions: actions })
    expect(html).not.toContain('memory-promotion-message')
    const shared = render({
      promotion: { ...basePromotion, canPromoteDepartments: [], canPromoteGlobal: false },
      promotionActions: actions,
    })
    expect(shared).not.toContain('>晋升<')
  })

  it('renders the review queue with approve/reject, but disables self-approval', () => {
    const html = render({
      promotion: {
        ...basePromotion,
        canReview: true,
        reviewQueue: [
          {
            promotion: {
              id: 'mp-1', memoryId: 'm-pitfall', title: '文件写入路径错误', type: 'pitfall',
              content: '写入前先确认目录存在。',
              status: 'pending', targetScope: 'department', departmentCode: 'dept-a', selfApproval: true,
            },
            selfApproval: true,
          },
        ],
      },
      promotionActions: actions,
    })
    expect(html).toContain('data-testid="memory-review"')
    expect(html).toContain('晋升审核')
    expect(html).toContain('通过')
    expect(html).toContain('拒绝')
    expect(html).toContain('自己提交的晋升需要另一位管理员审核。')
    // The reviewer sees what is being approved, not only a title.
    expect(html).toContain('写入前先确认目录存在。')
  })

  it('renders the department/global list as read-only content', () => {
    const html = render({
      promotion: {
        ...basePromotion,
        shared: [{
          id: 'mp-9', title: '指标口径排查', type: 'sop', content: '先查上游',
          scope: 'global', promotedAt: iso(1), promotedBy: '管理员',
        }],
      },
      promotionActions: actions,
    })
    expect(html).toContain('data-testid="memory-shared"')
    expect(html).toContain('部门和全局记忆')
    expect(html).toContain('指标口径排查')
    // The shared section carries no row actions at all.
    const sharedSection = html.slice(html.indexOf('data-testid="memory-shared"'))
    expect(sharedSection).not.toContain('查看')
    expect(sharedSection).not.toContain('忘记')
  })

  it('opens a target picker that distinguishes review from direct promotion', () => {
    const html = render({
      promotion: {
        ...basePromotion,
        target: { entry: entries[1]!, scope: 'department', confirm: false },
      },
      promotionActions: actions,
    })
    expect(html).toContain('晋升记忆')
    expect(html).toContain('提交审核')
    expect(html).toContain('直接生效（管理员确认）')
  })
})
