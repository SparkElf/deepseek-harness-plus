import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  diffSnapshots,
  isSummaryDocumentPath,
  parentChain,
  refreshDirtySummaries,
  scanKnowledgeTree,
  type ChangeSet,
  type ChangeSnapshot,
} from '../src/summaryIndex.ts'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kb-summary-index-'))
  roots.push(directory)
  return directory
}

async function write(root: string, relPath: string, content: string): Promise<void> {
  const absolute = join(root, relPath)
  await mkdir(join(absolute, '..'), { recursive: true })
  await writeFile(absolute, content, 'utf8')
}

function emptyChangeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return { changed: [], added: [], removed: [], dirtyDirectories: [], ...overrides }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('scanKnowledgeTree', () => {
  it('hashes text documents in deterministic sorted order and skips reserved or hidden folders', async () => {
    const root = await tempRoot()
    await write(root, 'a/one.md', '# One')
    await write(root, 'a/two.md', '# Two')
    await write(root, 'a/b/three.md', '# Three')
    await write(root, 'c.md', '# C')
    await write(root, 'a/.notes.md', 'hidden file')
    await write(root, 'image.png', 'not a document')
    await write(root, '.graphs/procurement/graph.json', '{}')
    await write(root, '.kg/links/edge.md', 'relation')
    await write(root, '.archive/graphs/old.md', 'archive')
    await write(root, '_trash/deleted.md', 'trash')
    await write(root, '.hidden/secret.md', 'hidden dir')

    const snapshot = await scanKnowledgeTree(root)

    expect(Object.keys(snapshot.files)).toEqual([
      'a/b/three.md',
      'a/one.md',
      'a/two.md',
      'c.md',
    ])
    const one = snapshot.files['a/one.md']
    expect(one?.sha256).toBe(createHash('sha256').update('# One').digest('hex'))
    expect(one?.mtimeMs).toBeGreaterThan(0)
  })

  it('is deterministic across repeated scans', async () => {
    const root = await tempRoot()
    await write(root, 'a/one.md', '# One')
    await write(root, 'b/two.md', '# Two')

    const first = await scanKnowledgeTree(root)
    const second = await scanKnowledgeTree(root)

    expect(second).toEqual(first)
  })

  it('returns an empty snapshot when the root does not exist', async () => {
    const root = await tempRoot()
    await expect(scanKnowledgeTree(join(root, 'missing'))).resolves.toEqual({ files: {} })
  })

  it('recognizes the document extensions it tracks', () => {
    expect(isSummaryDocumentPath('a.md')).toBe(true)
    expect(isSummaryDocumentPath('a.MARKDOWN')).toBe(true)
    expect(isSummaryDocumentPath('a.txt')).toBe(true)
    expect(isSummaryDocumentPath('a.text')).toBe(true)
    expect(isSummaryDocumentPath('a.json')).toBe(false)
    expect(isSummaryDocumentPath('a.png')).toBe(false)
  })
})

describe('parentChain', () => {
  it('returns the fixed root-first ancestor chain', () => {
    expect(parentChain('a/b/c.md')).toEqual(['a', 'a/b'])
    expect(parentChain('a/b/c/d.md')).toEqual(['a', 'a/b', 'a/b/c'])
    expect(parentChain('a.md')).toEqual([])
    expect(parentChain('a/b.md')).toEqual(['a'])
  })

  it('normalizes separators and refuses paths outside the root', () => {
    expect(parentChain('a\\b\\c.md')).toEqual(['a', 'a/b'])
    expect(parentChain('/a/b.md')).toEqual([])
    expect(parentChain('../a.md')).toEqual([])
    expect(parentChain('a/../b.md')).toEqual([])
  })
})

describe('diffSnapshots', () => {
  it('reports changed, added and removed documents with their dirty directory chain', () => {
    const previous: ChangeSnapshot = {
      files: {
        'a/one.md': { mtimeMs: 1, sha256: 'aaa' },
        'a/b/two.md': { mtimeMs: 2, sha256: 'bbb' },
        'c.md': { mtimeMs: 3, sha256: 'ccc' },
      },
    }
    const next: ChangeSnapshot = {
      files: {
        // Same bytes, new mtime: touching is not a change.
        'a/one.md': { mtimeMs: 10, sha256: 'aaa' },
        'a/b/two.md': { mtimeMs: 20, sha256: 'bbb2' },
        'a/new.md': { mtimeMs: 30, sha256: 'ddd' },
      },
    }

    expect(diffSnapshots(previous, next)).toEqual({
      changed: ['a/b/two.md'],
      added: ['a/new.md'],
      removed: ['c.md'],
      dirtyDirectories: ['a', 'a/b'],
    })
  })

  it('treats two identical snapshots as no change', () => {
    const snapshot: ChangeSnapshot = {
      files: { 'a/one.md': { mtimeMs: 1, sha256: 'aaa' } },
    }
    expect(diffSnapshots(snapshot, snapshot)).toEqual(emptyChangeSet())
  })
})

describe('scanKnowledgeTree + diffSnapshots', () => {
  it('detects a real edit, an addition and a removal', async () => {
    const root = await tempRoot()
    await write(root, 'a/one.md', 'one')
    await write(root, 'a/two.md', 'two')
    await write(root, 'b/three.md', 'three')

    const before = await scanKnowledgeTree(root)

    await write(root, 'a/one.md', 'one changed')
    await unlink(join(root, 'a/two.md'))
    await write(root, 'b/four.md', 'four')

    const after = await scanKnowledgeTree(root)
    const changes = diffSnapshots(before, after)

    expect(changes.changed).toEqual(['a/one.md'])
    expect(changes.added).toEqual(['b/four.md'])
    expect(changes.removed).toEqual(['a/two.md'])
    expect(changes.dirtyDirectories).toEqual(['a', 'b'])
  })

  it('does not treat an mtime-only touch as a change', async () => {
    const root = await tempRoot()
    await write(root, 'a/one.md', 'same bytes')

    const before = await scanKnowledgeTree(root)
    await utimes(join(root, 'a/one.md'), new Date(1_700_000_000_000), new Date(1_700_000_000_000))
    const after = await scanKnowledgeTree(root)

    expect(after.files['a/one.md']?.mtimeMs).not.toBe(before.files['a/one.md']?.mtimeMs)
    expect(after.files['a/one.md']?.sha256).toBe(before.files['a/one.md']?.sha256)
    expect(diffSnapshots(before, after).changed).toEqual([])
  })
})

describe('refreshDirtySummaries', () => {
  it('summarises only dirty documents, drops removed ones and aggregates directories in stable order', async () => {
    const root = await tempRoot()
    await write(root, 'a/one.md', 'one')
    await write(root, 'a/two.md', 'two')
    await write(root, 'a/b/three.md', 'three')

    const summarize = vi.fn(async (relPath: string, source: string) => `${relPath}=${source.trim()}`)
    const writes: Array<[string, string]> = []
    const writeIndex = vi.fn(async (relPath: string, summary: string) => {
      writes.push([relPath, summary])
    })

    const result = await refreshDirtySummaries({
      root,
      changeSet: emptyChangeSet({
        // Deliberately unsorted: the module owns the stable order.
        changed: ['a/one.md'],
        added: ['a/b/three.md'],
        removed: ['c.md'],
        dirtyDirectories: ['a/b'],
      }),
      summarize,
      writeIndex,
    })

    expect(summarize.mock.calls.map(([relPath]) => relPath)).toEqual([
      'a/b/three.md',
      'a/one.md',
    ])
    // The untouched sibling is never summarised.
    expect(summarize.mock.calls.map(([relPath]) => relPath)).not.toContain('a/two.md')
    expect(summarize).toHaveBeenCalledTimes(2)

    expect(writes).toEqual([
      ['a/b/three.md', 'a/b/three.md=three'],
      ['a/one.md', 'a/one.md=one'],
      ['c.md', ''],
      ['a', '- a/b/three.md: a/b/three.md=three\n- a/one.md: a/one.md=one'],
      ['a/b', '- a/b/three.md: a/b/three.md=three'],
    ])
    expect(result).toEqual({
      updated: ['a/b/three.md', 'a/one.md'],
      directories: ['a', 'a/b'],
    })
  })

  it('keeps directory aggregation in sorted child order for unsorted input', async () => {
    const root = await tempRoot()
    await write(root, 'a/one.md', 'one')
    await write(root, 'a/two.md', 'two')

    const summarize = vi.fn(async (relPath: string, source: string) => `${relPath}:${source}`)
    const writeIndex = vi.fn(async (_relPath: string, _summary: string) => undefined)

    await refreshDirtySummaries({
      root,
      changeSet: emptyChangeSet({ changed: ['a/two.md', 'a/one.md'] }),
      summarize,
      writeIndex,
    })

    expect(summarize.mock.calls.map(([relPath]) => relPath)).toEqual(['a/one.md', 'a/two.md'])
    const directoryCall = writeIndex.mock.calls.find(([relPath]) => relPath === 'a')
    expect(directoryCall?.[1]).toBe('- a/one.md: a/one.md:one\n- a/two.md: a/two.md:two')
  })

  it('drops a removed document without summarising it and without blanking other siblings', async () => {
    const root = await tempRoot()
    await write(root, 'a/two.md', 'two')

    const summarize = vi.fn(async () => 'summary')
    const writeIndex = vi.fn(async () => undefined)

    const result = await refreshDirtySummaries({
      root,
      changeSet: emptyChangeSet({ removed: ['a/two.md'], dirtyDirectories: ['a'] }),
      summarize,
      writeIndex,
    })

    expect(summarize).not.toHaveBeenCalled()
    expect(writeIndex).toHaveBeenCalledTimes(1)
    expect(writeIndex).toHaveBeenCalledWith('a/two.md', '')
    // No fresh child summary exists, so the aggregate is left alone rather than
    // rewritten from an incomplete set.
    expect(result).toEqual({ updated: [], directories: [] })
  })

  it('treats a dirty document that vanished before the read as removed', async () => {
    const root = await tempRoot()

    const summarize = vi.fn(async () => 'summary')
    const writeIndex = vi.fn(async () => undefined)

    const result = await refreshDirtySummaries({
      root,
      changeSet: emptyChangeSet({ changed: ['a/gone.md'] }),
      summarize,
      writeIndex,
    })

    expect(summarize).not.toHaveBeenCalled()
    expect(writeIndex).toHaveBeenCalledWith('a/gone.md', '')
    expect(result).toEqual({ updated: [], directories: [] })
  })

  it('rejects a change set that could read outside the root', async () => {
    const root = await tempRoot()
    const summarize = vi.fn(async () => 'summary')
    const writeIndex = vi.fn(async () => undefined)

    await expect(refreshDirtySummaries({
      root,
      changeSet: emptyChangeSet({ changed: ['../escape.md'] }),
      summarize,
      writeIndex,
    })).rejects.toThrow(/unsafe relative path/u)

    expect(summarize).not.toHaveBeenCalled()
    expect(writeIndex).not.toHaveBeenCalled()
  })
})
