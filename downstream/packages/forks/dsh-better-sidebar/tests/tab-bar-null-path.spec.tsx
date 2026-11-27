/**
 * Regression: a tab whose `path` is JSON `null` must not take the tab strip
 * down when its context menu opens.
 *
 * The menu's copy/reveal rows are computed during render from
 * `tabs[index].path`. The original predicate only excluded `undefined` and
 * `''`, so a null path reached `isAbsolutePath(null)` and threw
 * `Cannot read properties of null (reading 'startsWith')` — the exact error
 * the root RenderBoundary surfaced as the full-height sidebar rail.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { TabBar } from '../src/client/TabBar.tsx'
import type { SidebarTab } from '../src/client/state.ts'
import { t } from '../src/client/locales.ts'

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  document.body.innerHTML = ''
})

/** Mount the strip with the given tabs and return the tab elements. */
function mountBar(tabs: SidebarTab[]): HTMLElement[] {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(createElement(TabBar, {
      paneId: 'pane:1',
      tabs,
      active: tabs[0]!.id,
      onActivate: () => {},
      onClose: () => {},
      onNewTab: () => {},
      newTabOptions: [],
      onDropTab: () => {},
      onRevealInFileManager: () => {},
      onDownloadTab: () => {},
    }))
  })
  return [...container.querySelectorAll('[class*="tabList"] > [class*="tab"]')] as HTMLElement[]
}

describe('TabBar context menu with a null tab path', () => {
  it('renders the menu with the file rows disabled instead of throwing', () => {
    const tabs: SidebarTab[] = [
      // The native surface does not validate navigation.params: an absent
      // path can be null rather than undefined.
      { id: 't1', type: 'editor', title: 'File', path: null as unknown as string },
      { id: 't2', type: 'git', title: 'Git' },
    ]
    const [tab0] = mountBar(tabs)
    expect(tab0).toBeDefined()

    expect(() => {
      act(() => {
        tab0!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 12 }))
      })
    }).not.toThrow()

    // The menu opened, and both copy rows are disabled (no path to copy).
    const rows = [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[]
    const copyRelative = rows.find(row => row.textContent?.includes(t('copyRelative')))
    const copyAbsolute = rows.find(row => row.textContent?.includes(t('copyAbsolute')))
    expect(copyRelative).toBeDefined()
    expect(copyAbsolute).toBeDefined()
    expect(copyRelative?.getAttribute('aria-disabled') === 'true' || copyRelative?.hasAttribute('disabled')).toBe(true)
    expect(copyAbsolute?.getAttribute('aria-disabled') === 'true' || copyAbsolute?.hasAttribute('disabled')).toBe(true)
  })
})