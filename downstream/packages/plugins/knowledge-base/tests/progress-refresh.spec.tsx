/**
 * @vitest-environment jsdom
 *
 * 手动排队的提取任务必须出现在进度弹窗里。
 *
 * 用户报的是「我点击提取 markdown 没见出现在进度弹窗里面」。根因是弹窗**只在已经知道
 * 有 pending/running 任务时才轮询**，而手动点「提取 Markdown」恰好是它一个活动任务都
 * 不知道的时刻——于是它不轮询，任务永远不出现。
 *
 * 修法是给弹窗一个刷新信号：页面 bump 一次，弹窗立刻拉一次 `extract.status`。这里是
 * 断言**拉取函数被再次调用**，不是断言某个任务渲染出来——渲染可能因为别的原因碰巧看到。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The primitives barrel imports CSS and a workspace-path helper this environment cannot
// resolve. Listed explicitly: vitest reads a module mock through its own ESM interop, so a
// Proxy is not consulted. Nothing here asserts markup.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const passthrough = (name: string) => {
    const Component = (props: Record<string, unknown>): React.ReactElement => {
      const { children } = props as { children?: React.ReactNode }
      return <div data-stub={name}>{children}</div>
    }
    Component.displayName = name
    return Component
  }
  const names = [
    'Button', 'Input', 'Modal', 'Tag', 'SegmentedTabs', 'Menu', 'MenuItemButton', 'FileTypeIcon', 'Tooltip',
    'IconCheckOutlineRegular', 'IconChevronDownOutlineRegular', 'IconChevronUpOutlineRegular',
    'IconDeliverDocRegular', 'IconFolderOpenOutlineRegular', 'IconListPenOutlineRegular',
    'IconPanelLeftOutlineRegular', 'IconPlusOutlineRegular', 'IconRightUpOutlineRegular',
    'IconSearchOutlineRegular', 'IconSlidersTwoOutlineRegular',
  ]
  const exports: Record<string, unknown> = { __esModule: true }
  for (const name of names) exports[name] = passthrough(name)
  return exports
})

const { KnowledgeProgressPopover } = await import('../src/client/KnowledgeProgressPopover.tsx')

const mounted: Array<{ unmount: () => void }> = []

afterEach(() => {
  for (const entry of mounted.splice(0)) entry.unmount()
  vi.unstubAllGlobals()
})

/** Copy resolver: the key itself, so nothing depends on wording. */
const t = (key: string): string => key

/**
 * Mount the popover with a counting `extract.status` fetch.
 * @param refreshSignal - the counter to render with.
 * @param calls - where to record each status read.
 * @returns The React root, so a test can re-render with a new signal.
 */
function mountPopover(refreshSignal: number, calls: string[]): {
  render: (signal: number) => void
} {
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url))
    // An empty queue: the interesting part is that a read HAPPENS, not what it returns.
    return {
      ok: true,
      status: 200,
      json: async () => ({ tasks: [], size: 0 }),
      text: async () => JSON.stringify({ tasks: [], size: 0 }),
    }
  })

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = (signal: number): void => {
    act(() => {
      root.render(<KnowledgeProgressPopover t={t} uploads={[]} watchExtraction refreshSignal={signal} />)
    })
  }
  render(refreshSignal)
  mounted.push({
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  })
  return { render }
}

describe('the progress panel re-reads extraction status when told to', () => {
  it('reads once when it mounts', async () => {
    const calls: string[] = []
    mountPopover(0, calls)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(calls.length).toBe(1)
  })

  it('reads again when the refresh signal bumps', async () => {
    // 点击「提取 Markdown」后页面 bump 一次 -> 弹窗必须再拉一次状态，否则那条任务
    // 永远不会出现（它只在已知有活动任务时轮询）。
    const calls: string[] = []
    const { render } = mountPopover(0, calls)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const afterMount = calls.length
    expect(afterMount).toBeGreaterThanOrEqual(1)

    render(1)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(calls.length).toBeGreaterThan(afterMount)
  })

  it('does not re-read when the signal is unchanged', async () => {
    // 父组件因为别的原因重渲染时不能变成 fetch 风暴。
    const calls: string[] = []
    const { render } = mountPopover(3, calls)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const settled = calls.length
    render(3)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(calls.length).toBe(settled)
  })
})
