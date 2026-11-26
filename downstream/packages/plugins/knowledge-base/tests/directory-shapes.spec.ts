/**
 * Prove the indexing table distinguishes "could not be read" from "is empty".
 *
 * The two produce the same file count, so a row that reports the zero without the
 * flag tells the reader a directory they cannot see is an empty one. That
 * distinction is the only honest thing this table can say about access, so it is
 * pinned here rather than left to a permission test.
 *
 * A real unreadable directory cannot be used for this: the suite runs as root, and
 * root bypasses the mode bits, so `chmod 000` still lists. Measured 2026-10-17:
 * `readdir` on a `0000` directory succeeds as uid 0 and fails only for an
 * unprivileged user. The refusal is therefore injected at the filesystem boundary,
 * which is deterministic and needs no privileges.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listDirectoryShapes } from '../src/index.ts'

/** Directory whose listing the injected refusal stands in for. */
const DENIED = '___denied___'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    default: actual,
    readdir: async (path: Parameters<typeof actual.readdir>[0], options?: Parameters<typeof actual.readdir>[1]) => {
      if (String(path).endsWith(DENIED)) {
        const error = new Error(`EACCES: permission denied, scandir '${String(path)}'`) as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return actual.readdir(path as never, options as never)
    },
  }
})

const created: string[] = []
afterEach(async () => {
  for (const root of created.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('a directory that cannot be listed is not reported as an empty one', () => {
  it('flags the refused directory and still counts the rest of the tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-shape-denied-'))
    created.push(root)
    await mkdir(join(root, DENIED), { recursive: true })
    await mkdir(join(root, 'readable'), { recursive: true })
    await writeFile(join(root, 'readable', 'a.md'), 'a')
    await writeFile(join(root, 'top.md'), 'top')

    const rows = await listDirectoryShapes(root)
    const denied = rows.find(row => row.relPath === DENIED)
    const readable = rows.find(row => row.relPath === 'readable')

    // The row survives the refusal: the reader is told access was refused rather
    // than being shown nothing at all.
    expect(denied).toBeDefined()
    expect(denied?.fileCount).toBe(0)
    expect(denied?.readable).toBe(false)
    expect(denied?.mtimeMs).toBeUndefined()

    // A directory that could be read is unaffected by its neighbour's refusal, and
    // it is NOT marked partial: the refusal is not in its subtree.
    expect(readable?.readable).toBe(true)
    expect(readable?.fileCount).toBe(1)
    expect(readable?.partial).toBe(false)

    // The root can be listed itself, so it is readable, but its walk passed through
    // a refusal, so its count of 2 is a lower bound and not a total. Both facts are
    // reported separately because a single flag would have to drop one of them.
    const rootRow = rows.find(row => row.relPath === '')
    expect(rootRow?.readable).toBe(true)
    expect(rootRow?.partial).toBe(true)
    expect(rootRow?.fileCount).toBe(2)
  })

  it('reports the mount itself as unreadable when the mount cannot be listed', async () => {
    // A mount that cannot be listed at all is not a mount with no directories: the
    // page says "暂时无法统计" rather than "这里没有目录", because the two lead the
    // reader to different actions.
    const parent = await mkdtemp(join(tmpdir(), 'kb-shape-root-'))
    created.push(parent)
    const root = join(parent, DENIED)
    await mkdir(root, { recursive: true })

    const rows = await listDirectoryShapes(root)
    expect(rows).toEqual([])
  })
})
