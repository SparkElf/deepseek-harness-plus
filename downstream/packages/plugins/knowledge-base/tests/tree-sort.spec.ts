/**
 * 树的排序偏好：三项选择 + 刷新后保持。
 *
 * 排序是**视图偏好**，所以存在浏览器里而不是视图目录：它只决定一个人怎么扫这列表，
 * 没有跨机器共享的价值，而一次往返后才重排会让单击控件显得卡住。
 *
 * 这里用可注入的 localStorage 桩验证"读得回、写得进、坏数据不炸"。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TREE_SORT,
  TREE_SORT_KEYS,
  isTreeSortKey,
  readTreeSort,
  treeSortStorageKey,
  writeTreeSort,
} from '../src/client/useTreeSort.ts'

/** A minimal in-memory localStorage. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
  })
  return store
}

afterEach(() => { vi.unstubAllGlobals() })

describe('the tree offers three orderings plus the host order', () => {
  it('lists mtime first because it is the default', () => {
    // 菜单顺序即数组顺序；默认项排第一，读者不用先找。
    expect(TREE_SORT_KEYS[0]).toBe(DEFAULT_TREE_SORT)
    expect(DEFAULT_TREE_SORT).toBe('mtime')
  })

  it('offers mtime, name, type and size', () => {
    expect([...TREE_SORT_KEYS]).toEqual(['mtime', 'name', 'type', 'size'])
  })

  it('rejects anything that is not one of them', () => {
    expect(isTreeSortKey('mtime')).toBe(true)
    expect(isTreeSortKey('size')).toBe(true)
    // 旧版本可能存过别的值；不认识就当没存过。
    expect(isTreeSortKey('date')).toBe(false)
    expect(isTreeSortKey('')).toBe(false)
    expect(isTreeSortKey(undefined)).toBe(false)
  })
})

describe('the key is scoped to the panel', () => {
  it('namespaces the stored key', () => {
    // 两个知识库面板（或同源的两个部署）不能读到对方的选择。
    expect(treeSortStorageKey('personal/uid')).toBe('dsh-kb-sort:personal/uid')
    expect(treeSortStorageKey('')).toBe('dsh-kb-sort:default')
    expect(treeSortStorageKey('a')).not.toBe(treeSortStorageKey('b'))
  })
})

describe('the choice survives a reload', () => {
  it('writes and reads back', () => {
    installStorage()
    writeTreeSort('panel-1', 'size')
    // 这就是"刷新后保持"：新一次读取拿到的是存进去的值。
    expect(readTreeSort('panel-1')).toBe('size')
  })

  it('answers the default when nothing was stored', () => {
    installStorage()
    expect(readTreeSort('never-used')).toBe(DEFAULT_TREE_SORT)
  })

  it('keeps panels independent', () => {
    installStorage()
    writeTreeSort('a', 'name')
    writeTreeSort('b', 'size')
    expect(readTreeSort('a')).toBe('name')
    expect(readTreeSort('b')).toBe('size')
  })

  it('falls back to the default for a value it does not recognise', () => {
    // 更早的构建可能存过别的键名，不能让页面崩在这种历史值上。
    const store = installStorage()
    store.set(treeSortStorageKey('p'), 'by-vibes')
    expect(readTreeSort('p')).toBe(DEFAULT_TREE_SORT)
  })

  it('survives storage that throws', () => {
    // 隐私模式/服务端渲染下 localStorage 可能是不可用的；读不到偏好不该让树挂掉。
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    })
    expect(readTreeSort('p')).toBe(DEFAULT_TREE_SORT)
    expect(() => { writeTreeSort('p', 'size') }).not.toThrow()
  })

  it('survives having no storage at all', () => {
    // 没有 localStorage 的环境（测试、SSR）走同一条回落路径。
    vi.stubGlobal('localStorage', undefined)
    expect(readTreeSort('p')).toBe(DEFAULT_TREE_SORT)
    expect(() => { writeTreeSort('p', 'size') }).not.toThrow()
  })
})
