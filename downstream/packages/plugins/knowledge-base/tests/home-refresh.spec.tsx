// @ts-nocheck
/**
 * @vitest-environment jsdom
 *
 * 主页列表的刷新信号。
 *
 * 用户报的是「上传成功后这个文件树更新了，主页的列表没自动刷新」。根因不是依赖数组
 * 漏了 tick，而是 `KnowledgeHome` **根本没有接这个 prop** —— 树接了、列表视图接了、
 * 主页没接，所以只有主页是陈旧的。
 *
 * 这里断言的是**取数函数被调用的次数**，不是「新文件出现在列表里」。后者可能因为
 * 别的原因碰巧看到（页面重渲染、别的 refreshTick、测试自己触发的一次读），而调用次数
 * 只能由那一个信号解释。这个包这轮已经两次栽在"断言结果碰巧通过"上。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The primitives package imports CSS at module scope and pulls a workspace-path helper
// that this test environment cannot resolve, so the whole barrel is stood in for. Every
// component it replaces is a pass-through: this file asserts FETCH COUNTING, not markup,
// so the stand-ins only have to render.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const passthrough = (name: string) => {
    const Component = (props: Record<string, unknown>): React.ReactElement => {
      const { children } = props as { children?: React.ReactNode }
      return <div data-stub={name}>{children}</div>
    }
    Component.displayName = name
    return Component
  }
  // Listed explicitly rather than proxied: vitest's module mock is read through its own
  // ESM interop, so a Proxy's `get` is not consulted the way the component tree expects.
  const names = [
    'Button', 'Input', 'Modal', 'Tag', 'SegmentedTabs', 'Menu', 'MenuItemButton', 'FileTypeIcon',
    'IconCheckOutlineRegular', 'IconChevronDownOutlineRegular', 'IconChevronUpOutlineRegular',
    'IconDeliverDocRegular', 'IconFolderOpenOutlineRegular', 'IconListPenOutlineRegular',
    'IconPanelLeftOutlineRegular', 'IconPlusOutlineRegular', 'IconRightUpOutlineRegular',
    'IconSearchOutlineRegular', 'IconSlidersTwoOutlineRegular',
  ]
  const exports: Record<string, unknown> = { __esModule: true }
  for (const name of names) exports[name] = passthrough(name)
  return exports
})

const { KnowledgeHome } = await import('../src/client/KnowledgeHome.tsx')

/** Every mount the tests create, so each one is torn down. */
const mounted: Array<{ unmount: () => void }> = []

afterEach(() => {
  for (const entry of mounted.splice(0)) entry.unmount()
})

/** Copy resolver: returns the key, so assertions never depend on wording. */
const t = (key: string): string => key

/**
 * Mount the table with a counting loader.
 * @param props - the extra props for this mount.
 * @returns The loader's call log.
 */
function mountHome(props: Partial<Parameters<typeof KnowledgeHome>[0]> = {}): { calls: string[] } {
  const calls: string[] = []
  const readHomeRows = async (mountPoint: string): Promise<never[]> => {
    calls.push(mountPoint)
    return []
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <KnowledgeHome
        t={t}
        mountPoint="/workspace/kb"
        readHomeRows={readHomeRows}
        {...props}
      />,
    )
  })
  mounted.push({
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  })
  return { calls }
}

describe('the Home table re-reads when the refresh signal bumps', () => {
  it('reads once on mount', async () => {
    const { calls } = mountHome()
    // The effect runs asynchronously; flush it.
    await act(async () => { await Promise.resolve() })
    expect(calls.length).toBe(1)
  })

  it('calls the loader again for each bump', async () => {
    // The load-bearing assertion: 1 read on mount, then one more per bump.
    const calls: string[] = []
    const readHomeRows = async (mountPoint: string): Promise<never[]> => {
      calls.push(mountPoint)
      return []
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const render = (tick: number): void => {
      act(() => {
        root.render(<KnowledgeHome t={t} mountPoint="/workspace/kb" refreshTick={tick} readHomeRows={readHomeRows} />)
      })
    }
    render(0)
    await act(async () => { await Promise.resolve() })
    expect(calls.length).toBe(1)

    render(1)
    await act(async () => { await Promise.resolve() })
    expect(calls.length).toBe(2)   // ← the fix: the table re-reads on the shared signal

    render(2)
    await act(async () => { await Promise.resolve() })
    expect(calls.length).toBe(3)

    mounted.push({ unmount: () => { act(() => { root.unmount() }); container.remove() } })
  })

  it('does not re-read when the tick is unchanged', async () => {
    // A parent re-render for any other reason must not cause a fetch storm.
    const calls: string[] = []
    const readHomeRows = async (): Promise<never[]> => { calls.push('x'); return [] }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const render = (): void => {
      act(() => {
        root.render(<KnowledgeHome t={t} mountPoint="/workspace/kb" refreshTick={7} readHomeRows={readHomeRows} />)
      })
    }
    render()
    await act(async () => { await Promise.resolve() })
    expect(calls.length).toBe(1)

    render()
    await act(async () => { await Promise.resolve() })
    // The effect's dependency is [read, mountPoint, refreshTick]; an unchanged tick
    // leaves `read` identical, so the effect does not run again.
    expect(calls.length).toBe(1)

    mounted.push({ unmount: () => { act(() => { root.unmount() }); container.remove() } })
  })
})
