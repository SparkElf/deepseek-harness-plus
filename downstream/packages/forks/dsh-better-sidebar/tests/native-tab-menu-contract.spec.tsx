/**
 * Native right-Sidebar tab-menu contract (`src/client/native/tab-menu.tsx`).
 *
 * The host owns ONE context menu per tab; this plugin only contributes rows.
 * The rows are content actions, so their presence must follow the tab's
 * `contentId`, not the tab's icon:
 *
 * - a real file tab (`dsh-resource://file/...`, any kind the host draws it
 *    with) contributes the seven file/batch rows;
 * - the Files page tab (`kind: 'files'`, `contentId: 'sidebar://files'`) is a
 *    page, not a file, so it contributes ONLY the batch close rows. Copy /
 *    download / reveal must not appear there.
 *
 * A folder icon alone does not mean "file tab": DSH's Files page tab has the
 * folder icon and `sidebar://files`, and that is the normal two-row menu the
 * user sees. These tests pin the distinction so a future `isFileTab` change
 * cannot silently strip a real file tab's actions or add file actions to the
 * Files page.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Fragment, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { registerNativeTabMenuItems } from '../src/client/native/tab-menu.tsx'
import { copiedPaths } from '../src/client/native/tab-menu.tsx'
import type { Context } from '../src/context-types.ts'
import type { BetterSidebarService } from '../src/client/service.ts'

/** Point the browser-language fallback at Chinese so the labels assert. */
function stubZh(): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN' },
    configurable: true,
  })
}

/** The host's TabRecord slice these rows read. */
interface TestTab {
  readonly id: string
  readonly kind: string
  readonly contentId: string
}

/** One captured `sidebar.right.tab.menu.item` registration. */
interface CapturedEntry {
  readonly slot: string
  readonly id: string
  readonly order: number
  readonly component: (props: {
    readonly tab: TestTab
    readonly dismiss: () => void
    readonly sessionId?: string
  }) => ReactNode
}

const SESSION_ID = 'session-1'
const CWD = '/work'
const FILE_CONTENT_ID = `dsh-resource://file/session/${SESSION_ID}/AGENTS.md`
const FILES_CONTENT_ID = 'sidebar://files'

/** Capture the plugin's slot registrations without booting the host. */
function captureEntries(): CapturedEntry[] {
  const entries: CapturedEntry[] = []
  const ctx = {
    slots: {
      inject: (_name: string, callback: () => unknown) => {
        callback()
        return () => {}
      },
      register: (
        definition: { name: string; id: string; order: number },
        component: CapturedEntry['component'],
      ) => {
        entries.push({ slot: definition.name, id: definition.id, order: definition.order, component })
        return () => {}
      },
    },
    sessions: {
      list: {
        subscribe: () => () => {},
        getSnapshot: () => ({ byId: { [SESSION_ID]: { cwd: CWD } } }),
      },
    },
    get: (key: string) => key === 'sidebarRight'
      ? { tabsIn: () => [{ id: 'tab3' }, { id: 'tab4' }] }
      : undefined,
  } as unknown as Context
  const service = {
    isTabEnabled: () => true,
    getTabs: () => [],
    revealInExplorer: vi.fn(),
  } as unknown as BetterSidebarService
  registerNativeTabMenuItems(ctx, service)
  return entries
}

/** Render every contribution for one tab inside a host-shaped single menu. */
function renderMenu(tab: TestTab): { items: HTMLElement[]; root: Root; container: HTMLElement } {
  const entries = captureEntries()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(Fragment, null,
      createElement('div', { role: 'menu' },
        ...entries.map(entry => createElement(entry.component, {
          key: entry.id,
          tab,
          dismiss: () => {},
          sessionId: SESSION_ID,
        })))))
  })
  return {
    items: [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')],
    root,
    container,
  }
}

/** The visible labels, in registration order. */
function labels(items: readonly HTMLElement[]): string[] {
  return items.map(item => (item.textContent ?? '').trim())
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('native tab menu contributions', () => {
  it('projects a file address into both copy spellings and rejects the Files page address', () => {
    expect(copiedPaths(FILE_CONTENT_ID, CWD)).toEqual({
      relative: 'AGENTS.md',
      absolute: '/work/AGENTS.md',
    })
    expect(copiedPaths('dsh-resource://file/absolute/outside/x.ts', CWD)).toEqual({
      absolute: '/outside/x.ts',
      relative: undefined,
    })
    // The Files page is a page address, not a file: no copy rows apply.
    expect(copiedPaths(FILES_CONTENT_ID, CWD)).toBeUndefined()
  })

  it('gives a real file tab the seven file/batch rows in order', () => {
    stubZh()
    const { items, root } = renderMenu({ id: 'tab4', kind: 'editor', contentId: FILE_CONTENT_ID })
    try {
      expect(labels(items)).toEqual([
        '复制相对地址', '复制绝对地址', '下载',
        '关闭其他页签', '关闭全部页签',
        '打开所在文件夹', '打开所在位置',
      ])
      expect(items.every(item => (item as HTMLButtonElement).disabled === false)).toBe(true)
    } finally {
      act(() => { root.unmount() })
    }
  })

  it('gives a host-owned file kind the same seven rows (content address decides, not the kind)', () => {
    stubZh()
    const { items, root } = renderMenu({ id: 'tab5', kind: 'text', contentId: FILE_CONTENT_ID })
    try {
      expect(labels(items)).toEqual([
        '复制相对地址', '复制绝对地址', '下载',
        '关闭其他页签', '关闭全部页签',
        '打开所在文件夹', '打开所在位置',
      ])
    } finally {
      act(() => { root.unmount() })
    }
  })

  it('keeps the Files page tab to the two legal batch close rows', () => {
    stubZh()
    const { items, root } = renderMenu({ id: 'tab3', kind: 'files', contentId: FILES_CONTENT_ID })
    try {
      expect(labels(items)).toEqual(['关闭其他页签', '关闭全部页签'])
    } finally {
      act(() => { root.unmount() })
    }
  })

  it('registers every row once, into the one host menu slot', () => {
    const entries = captureEntries()
    expect(entries).toHaveLength(7)
    expect(new Set(entries.map(entry => entry.id)).size).toBe(7)
    expect(new Set(entries.map(entry => entry.slot))).toEqual(new Set(['sidebar.right.tab.menu.item']))
    // The host draws the menu; the plugin must not add a second one.
    stubZh()
    const { container, root } = renderMenu({ id: 'tab4', kind: 'editor', contentId: FILE_CONTENT_ID })
    try {
      expect(container.querySelectorAll('[role="menu"]')).toHaveLength(1)
      expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(7)
    } finally {
      act(() => { root.unmount() })
    }
  })
})