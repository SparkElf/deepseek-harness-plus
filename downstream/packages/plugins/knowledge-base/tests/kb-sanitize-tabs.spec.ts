import { describe, expect, it } from 'vitest'
import { sanitizeExplorerTabs } from '../src/client/sanitizeExplorerTabs.ts'

function storage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial))
  return {
    get length() { return data.size },
    key(index: number) { return [...data.keys()][index] ?? null },
    getItem(key: string) { return data.get(key) ?? null },
    setItem(key: string, value: string) { data.set(key, value) },
    removeItem(key: string) { data.delete(key) },
    dump: () => Object.fromEntries(data),
  }
}

const tab = (path: string) => ({ type: 'file', path, title: path })

describe('sanitizeExplorerTabs', () => {
  it('drops old session-scoped explorer tabs and keeps normal tabs', () => {
    const store = storage({
      'dsh-sidebar:v1:s1': JSON.stringify({
        root: { tabs: [tab('dsh-resource://file/session/%40kb-explorer/global/a.md'), tab('dsh-resource://file/absolute/workspace/a.md')] },
        bottom: { tabs: [tab('dsh-resource://file/session/@kb-explorer/global/b.md')] },
      }),
    })
    expect(sanitizeExplorerTabs(store)).toBe(1)
    const parsed = JSON.parse(store.dump()['dsh-sidebar:v1:s1']!) as { root: { tabs: unknown[] }; bottom: { tabs: unknown[] } }
    expect(parsed.root.tabs).toHaveLength(1)
    expect(parsed.bottom.tabs).toHaveLength(0)
    expect(JSON.stringify(parsed)).not.toContain('kb-explorer')
  })

  it('removes a whole layout keyed by the placeholder and leaves unrelated storage alone', () => {
    const store = storage({
      'dsh-sidebar:v1:@kb-explorer': '{"root":{"tabs":[]}}',
      'dsh-sidebar:v1:real': '{"root":{"tabs":[]}}',
      'other:key': 'keep',
    })
    expect(sanitizeExplorerTabs(store)).toBe(1)
    expect(store.dump()).toEqual({ 'dsh-sidebar:v1:real': '{"root":{"tabs":[]}}', 'other:key': 'keep' })
  })

  it('does not rewrite layouts that never mention the placeholder', () => {
    const original = '{"root":{"tabs":[{"type":"file","path":"dsh-resource://file/absolute/workspace/a.md"}]}}'
    const store = storage({ 'dsh-sidebar:v1:s1': original })
    expect(sanitizeExplorerTabs(store)).toBe(0)
    expect(store.dump()['dsh-sidebar:v1:s1']).toBe(original)
  })
})
