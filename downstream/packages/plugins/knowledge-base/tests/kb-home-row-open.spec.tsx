// @ts-nocheck
// @vitest-environment jsdom
/**
 * The Home table's row is itself a target: the title is a link, but a reader who
 * clicks the document card (name cell, owner cell, whitespace) expects the same
 * open. This mounts the real component and clicks a non-control cell, so it proves
 * the row-level handler reaches `onOpen` rather than asserting source text.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
    'Button', 'Input', 'Modal', 'Tag', 'Tooltip', 'SegmentedTabs', 'Menu', 'MenuItemButton', 'FileTypeIcon',
    'IconCheckOutlineRegular', 'IconChevronDownOutlineRegular', 'IconChevronUpOutlineRegular',
    'IconDeliverDocRegular', 'IconFolderOpenOutlineRegular', 'IconListPenOutlineRegular',
    'IconPanelLeftOutlineRegular', 'IconPlusOutlineRegular', 'IconRightUpOutlineRegular',
    'IconSearchOutlineRegular', 'IconChecklistOutline14', 'IconArchiveOutline20', 'IconWarningOutline16', 'IconSettingsOutline16', 'IconPanelLeftOutline16', 'IconChevronUpOutline14', 'IconCheckOutline16', 'IconListPenOutline16', 'IconFolderOpen16', 'IconRightUpOutline14', 'IconSlidersTwoOutlineRegular',
  ]
  const exports: Record<string, unknown> = { __esModule: true }
  for (const name of names) exports[name] = passthrough(name)
  return exports
})

const { KnowledgeHome } = await import('../src/client/KnowledgeHome.tsx')

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ unmount: () => void }> = []

afterEach(() => {
  for (const entry of mounted.splice(0)) entry.unmount()
})

const t = (key: string): string => key

const rows = [
  {
    relPath: 'personal/知识图谱/工作轨迹/个人知识库/scope.md',
    name: 'scope.md',
    location: 'personal/知识图谱/工作轨迹/个人知识库',
    mtimeMs: Date.UTC(2026, 9, 31),
  },
]

describe('the Home document row opens the document', () => {
  it('calls onOpen when a non-control cell is clicked', async () => {
    const onOpen = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        <KnowledgeHome
          t={t}
          mountPoint="/workspace/kb"
          readHomeRows={async () => rows}
          onOpen={onOpen}
        />,
      )
    })
    mounted.push({
      unmount: () => {
        act(() => { root.unmount() })
        container.remove()
      },
    })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const tr = [...container.querySelectorAll('tbody tr')]
      .find((candidate) => candidate.textContent?.includes('scope.md')) as HTMLTableRowElement | undefined
    expect(tr).toBeTruthy()
    const locationCell = tr?.querySelectorAll('td')[1] as HTMLTableCellElement | undefined
    expect(locationCell).toBeTruthy()
    locationCell?.click()

    expect(onOpen).toHaveBeenCalledWith(rows[0].relPath)
  })

  it('does not open when a control inside the row is clicked', async () => {
    const onOpen = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        <KnowledgeHome
          t={t}
          mountPoint="/workspace/kb"
          readHomeRows={async () => rows}
          onOpen={onOpen}
        />,
      )
    })
    mounted.push({
      unmount: () => {
        act(() => { root.unmount() })
        container.remove()
      },
    })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const row = [...container.querySelectorAll('tbody tr')]
      .find((candidate) => candidate.textContent?.includes('scope.md')) as HTMLTableRowElement | undefined
    expect(row).toBeTruthy()
    const titleButton = [...(row?.querySelectorAll('button') ?? [])]
      .find((candidate) => candidate.textContent?.includes('scope.md')) as HTMLButtonElement | undefined
    expect(titleButton).toBeTruthy()
    titleButton?.click()
    // The title's own handler is the existing open path; it must fire exactly once,
    // not once for the link and again through the row.
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})
