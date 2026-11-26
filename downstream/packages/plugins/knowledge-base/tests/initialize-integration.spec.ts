// @ts-nocheck
/** Integration: the initialiser over the REAL write path, in a temp root. */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createInitializer } from '../src/initialize.ts'
import { createKnowledgeEntry, type Config } from '../src/index.ts'

let root: string | undefined
afterEach(async () => { if (root !== undefined) await rm(root, { recursive: true, force: true }); root = undefined })

describe('provisioning over the real write path', () => {
  it('creates the tree on disk, then skips everything on a second run', async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-init-'))
    // `localConfig` reads `baseUrl.trim()`, so the fixture has to carry the real shape
    // rather than only the fields this test happens to care about.
    const config = { actualRoot: root, mountPoint: join(root, 'm'), viewRoot: join(root, 'v'), baseUrl: '' } as Config
    const init = createInitializer({
      createDirectory: async relPath => { await createKnowledgeEntry(config, relPath, { directory: true }) },
      createDocument: async (relPath, content) => { await createKnowledgeEntry(config, relPath, { directory: false, content }) },
      tutorialHtml: () => '<html>real tutorial</html>',
    }, () => undefined)

    const first = await init.ensure()
    expect(first.buckets.map(b => b.outcome)).toEqual(['created', 'created', 'created'])
    expect(first.tutorial).toBe('written')
    // Real directories on disk, and the real document is readable.
    for (const bucket of ['global', 'department', 'personal']) {
      expect((await stat(join(root, bucket))).isDirectory()).toBe(true)
    }
    expect(await readFile(join(root, 'global', '万相AI使用教程.html'), 'utf8')).toBe('<html>real tutorial</html>')

    const second = await init.ensure()
    expect(second.buckets.map(b => b.outcome)).toEqual(['exists', 'exists', 'exists'])
    expect(second.tutorial).toBe('skipped')
  })
})
