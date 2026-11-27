/**
 * FileTree's appended context-menu rows: `extraMenuItems`.
 *
 * The prop exists so a caller can add its own actions WITHOUT taking the native
 * ones away — the regression this guards against is a caller replacing the menu,
 * which the user then reports as "the original features are gone". The cases
 * below therefore pin three separate contracts:
 *
 * 1. Absence is inert: no prop means the menu is exactly the native list, with
 *    no trailing separator (every existing caller keeps its current rendering).
 * 2. Presence appends: the caller's rows come AFTER every native row, inside the
 *    same menu container (no second surface), preceded by one separator.
 * 3. The payload is right: `when` filters per entry, and `onSelect` receives the
 *    right-clicked entry's relPath (relative to `cwd`, the same spelling the
 *    native copy-relative row produces) and isDir.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree, type FileTreeMenuItem } from '../src/client/FileTree.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest follows the OS locale; pin en-US so the native rows' copy is stable.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { fsTrees } = vi.hoisted(() => ({
  fsTrees: vi.fn(async (_scope: unknown, paths: readonly string[]) => ({ levels: paths.map(path => listingFor(path)) })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees,
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

const ROOT_ENTRIES = [
  { name: 'sub', path: '/tmp/sub', isDir: true },
  { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
]

function listingFor(path: string): { path: string; entries: typeof ROOT_ENTRIES; truncated: boolean } {
  return {
    path,
    entries: path === '/tmp/sub' ? [{ name: 'inner.txt', path: '/tmp/sub/inner.txt', isDir: false }] : ROOT_ENTRIES,
    truncated: false,
  }
}

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

/**
 * Mount the tree with a caller-owned expansion set (the real caller owns it too).
 * @param extra - the appended rows to pass, or omitted for the native list.
 * @returns the mounted container and an unmount handle.
 */
function mountTree(extra?: readonly FileTreeMenuItem[]): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  function Host(): ReactNode {
    const [expanded, setExpanded] = useState<string[]>([])
    return createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded,
      revealed: [],
      onToggle: (path: string) => {
        setExpanded(current => current.includes(path) ? current.filter(item => item !== path) : [...current, path])
      },
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
      // Spread so the ABSENT case really passes no key at all -- that is the
      // backwards-compatibility contract, not "passes an empty array".
      ...(extra === undefined ? {} : { extraMenuItems: extra }),
    })
  }
  act(() => { root.render(createElement(Host)) })
  return { container, unmount: () => { act(() => { root.unmount() }); container.remove() } }
}

/** One tree row by its displayed name. */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[class*="explorerRow"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

function openMenu(container: HTMLElement, name: string): void {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })
  act(() => { rowByName(container, name).dispatchEvent(event) })
}

/** Every visible menu row's label, in DOM order (native and appended alike). */
function menuLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(el => el.textContent ?? '')
}

/** Activate one menu row by its exact label. */
function clickMenuitem(label: string): void {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(el => el.textContent === label)
  if (item === undefined) throw new Error(`menuitem not found: ${label}`)
  act(() => { item.click() })
}

/**
 * Let the tree finish the async first-level load.
 *
 * `mountTree` returns before the `fs.tree` answer arrives, so the rows do not exist
 * yet. One empty `await act()` round-trips the pending promise chain and commits.
 */
async function settled(tree: Harness): Promise<Harness> {
  await act(async () => {})
  return tree
}

let harness: Harness
afterEach(() => {
  harness?.unmount()
  document.body.innerHTML = ''
  fsTrees.mockReset()
  fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({ levels: paths.map(path => listingFor(path)) }))
})

describe('extraMenuItems absent', () => {
  it('renders the same menu it always did, with no trailing separator', async () => {
    // The compatibility contract: another plugin renders this component too, and
    // it must not gain a row, lose a row, or gain a stray hairline.
    harness = await settled(mountTree())
    openMenu(harness.container, 'a.ts')

    const labels = menuLabels()
    expect(labels.length).toBeGreaterThan(0)
    // A non-root row's native list ends with the mutate block (rename / delete),
    // after the copy rows -- the shipped order, unchanged by this feature.
    expect(labels.at(-2)).toBe('Rename')
    expect(labels.at(-1)).toBe('Delete')
    expect(labels).toContain('Copy relative path')
    expect(labels.indexOf('Copy absolute path')).toBeLessThan(labels.indexOf('Rename'))
    // Nothing appended: no separator beyond what the native list already draws.
    const separators = document.querySelectorAll('[role="separator"], [class*="separator"]')
    const before = separators.length

    harness.unmount()
    document.body.innerHTML = ''
    // Same tree with an EMPTY array is the other half of "absent": still no rows.
    harness = await settled(mountTree([]))
    openMenu(harness.container, 'a.ts')
    expect(menuLabels()).toEqual(labels)
    expect(document.querySelectorAll('[role="separator"], [class*="separator"]').length).toBe(before)
  })

  it('keeps the native rows in their shipped order', async () => {
    // The user's complaint was "the original features are gone", so the order is
    // part of the contract, not incidental.
    harness = await settled(mountTree())
    openMenu(harness.container, 'sub')
    const labels = menuLabels()
    expect(labels).toContain('Upload here')
    expect(labels).toContain('New folder')
    expect(labels).toContain('New file')
    expect(labels.indexOf('Upload here')).toBeLessThan(labels.indexOf('New folder'))
    expect(labels.indexOf('New folder')).toBeLessThan(labels.indexOf('New file'))
    // Copy rows stay after the directory actions on a directory row.
    expect(labels.indexOf('New file')).toBeLessThan(labels.indexOf('Copy relative path'))
  })
})

describe('extraMenuItems present', () => {
  /** Two rows whose callback records what it was handed. */
  function twoRows(): { rows: FileTreeMenuItem[]; seen: Array<{ relPath: string; isDir: boolean }> } {
    const seen: Array<{ relPath: string; isDir: boolean }> = []
    return {
      seen,
      rows: [
        { id: 'kb-extract', label: 'Extract Markdown', onSelect: target => { seen.push(target) } },
        { id: 'kb-share', label: 'Share', onSelect: target => { seen.push(target) } },
      ],
    }
  }

  it('appends both rows after every native row', async () => {
    const built = twoRows()
    harness = await settled(mountTree(built.rows))
    openMenu(harness.container, 'a.ts')

    const labels = menuLabels()
    // Both appended rows are present...
    expect(labels).toContain('Extract Markdown')
    expect(labels).toContain('Share')
    // ...and they are the LAST two, in the order they were declared.
    expect(labels.slice(-2)).toEqual(['Extract Markdown', 'Share'])
    // Nothing native was displaced: the mutate rows still sit right before them.
    expect(labels.slice(-4, -2)).toEqual(['Rename', 'Delete'])
  })

  it('draws the group separator only when a row survives', async () => {
    // A separator with nothing after it is a hairline the user cannot explain.
    const built = twoRows()
    harness = await settled(mountTree(built.rows))
    openMenu(harness.container, 'a.ts')
    const withRows = document.querySelectorAll('[role="separator"], [class*="separator"]').length

    harness.unmount()
    document.body.innerHTML = ''
    harness = await settled(mountTree([{ ...built.rows[0]!, when: () => false }]))
    openMenu(harness.container, 'a.ts')
    const withoutRows = document.querySelectorAll('[role="separator"], [class*="separator"]').length
    expect(withoutRows).toBeLessThan(withRows)
  })

  it('renders in the SAME menu container rather than a second surface', async () => {
    // The requirement is "same class and interaction, not a new floating layer".
    const built = twoRows()
    harness = await settled(mountTree(built.rows))
    openMenu(harness.container, 'a.ts')

    const appended = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(el => el.textContent === 'Extract Markdown')
    const native = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(el => el.textContent === 'Copy absolute path')
    expect(appended).toBeDefined()
    expect(native).toBeDefined()
    // One menu holds both: the appended row's class list is the native row's.
    expect(appended!.className).toBe(native!.className)
    // And there is exactly one menu surface on screen.
    expect(document.querySelectorAll('[role="menu"]').length).toBe(1)
  })

  it('hands onSelect the right-clicked row: relPath relative to cwd, and isDir', async () => {
    const built = twoRows()
    harness = await settled(mountTree(built.rows))

    openMenu(harness.container, 'a.ts')
    clickMenuitem('Extract Markdown')
    // '/tmp/a.ts' under cwd '/tmp' is 'a.ts' -- the same spelling the native
    // "copy relative path" row puts on the clipboard.
    expect(built.seen).toEqual([{ relPath: 'a.ts', isDir: false }])

    openMenu(harness.container, 'sub')
    clickMenuitem('Share')
    expect(built.seen.at(-1)).toEqual({ relPath: 'sub', isDir: true })
  })

  it('filters with when per entry, and passes the same target shape', async () => {
    const seenWhen: Array<{ relPath: string; isDir: boolean }> = []
    const selected: string[] = []
    harness = await settled(mountTree([
      {
        id: 'files-only',
        label: 'Extract Markdown',
        when: (target) => { seenWhen.push(target); return !target.isDir },
        onSelect: () => { selected.push('files-only') },
      },
      { id: 'always', label: 'Share', onSelect: () => { selected.push('always') } },
    ]))

    // File row: both apply.
    openMenu(harness.container, 'a.ts')
    expect(menuLabels()).toContain('Extract Markdown')
    expect(menuLabels()).toContain('Share')

    // Directory row: the filtered row is GONE (not disabled).
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    openMenu(harness.container, 'sub')
    expect(menuLabels()).not.toContain('Extract Markdown')
    expect(menuLabels()).toContain('Share')
    // `when` saw the directory, with the relPath the callback would receive.
    expect(seenWhen.at(-1)).toEqual({ relPath: 'sub', isDir: true })
  })

  it('does not let a caller id shadow a native action', async () => {
    // A colliding id would answer a native row and take a shipped feature away --
    // exactly the regression this prop exists to prevent -- so the group is refused.
    const collided: string[] = []
    harness = await settled(mountTree([
      { id: 'delete', label: 'Hijacked delete', onSelect: () => { collided.push('delete') } },
    ]))
    openMenu(harness.container, 'a.ts')

    expect(menuLabels()).not.toContain('Hijacked delete')
    expect(collided).toEqual([])
  })
})
