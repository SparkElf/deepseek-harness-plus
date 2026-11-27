import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createKnowledgeEntry,
  listDirectory,
  readKnowledgeFile,
  toolScopedActualPath,
  toolScopedViewPath,
  type Config,
} from '../src/index.ts'
import {
  assertToolPath,
  createKnowledgeFileTools,
  type KnowledgeFileEntry,
  type KnowledgeFileHit,
  type KnowledgeFileToolHost,
} from '../src/knowledgeTools.ts'
import { syncView } from '../src/views.ts'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kb-scope-regression-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const fakeExec = {} as never
const BARE_PERSONAL_PATH = '个人记忆图谱/记忆日志/2026-11-12.md'

interface ToolSpies {
  created: string[]
  overwritten: string[]
  statted: string[]
  trashed: string[]
  moved: Array<{ from: string; to: string }>
}

/**
 * A tiny host with the production `defaultScope` answer. It does not emulate the
 * filesystem; it records the path each tool hands to the host seam.
 */
function makeToolHost(spies: ToolSpies, options: { existing?: boolean } = {}): KnowledgeFileToolHost {
  return {
    resolveCaller: async () => ({ userId: 'u1', label: 'u1' }),
    defaultScope: () => 'personal',
    canRead: async () => true,
    canWrite: async () => true,
    list: async (relPath): Promise<KnowledgeFileEntry[]> => (relPath === ''
      ? []
      : [{ relPath: `${relPath}/a.md`, name: 'a.md', isDir: false, size: 1 }]),
    search: async (): Promise<KnowledgeFileHit[]> => [],
    readAuthorized: async () => ({ kind: 'text', content: 'hello', truncated: false }),
    statEntry: async relPath => {
      spies.statted.push(relPath)
      return options.existing === true ? { kind: 'file', size: 1 } : undefined
    },
    createEntry: async (relPath, createOptions) => {
      spies.created.push(relPath)
      return { relPath, kind: createOptions.directory ? 'directory' : 'file' }
    },
    overwriteFile: async relPath => { spies.overwritten.push(relPath) },
    moveEntry: async (from, to) => {
      spies.moved.push({ from, to })
      return { from, to }
    },
    deleteToTrash: async (_caller, relPath) => { spies.trashed.push(relPath) },
    refreshView: async () => ({}),
    readSettings: async () => ({ reviewRequired: false, mineruBaseUrl: '' }),
    parkWrite: async () => undefined,
    enqueueExtraction: async () => ({ outcome: 'queued' }),
    listExtractCandidates: async () => [],
    viewDir: () => '',
    appendAudit: async () => undefined,
    isExtractable: relPath => relPath.endsWith('.pdf'),
    now: () => new Date('2026-11-13T00:00:00.000Z'),
  }
}

const executeTool = async (
  host: KnowledgeFileToolHost,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, any>> => {
  const definition = createKnowledgeFileTools(host).find(tool => tool.name === name)
  if (definition === undefined) throw new Error(`missing tool ${name}`)
  return definition.execute(args, fakeExec) as Promise<Record<string, any>>
}

describe('model tool paths: bare means the caller personal bucket', () => {
  it('prefixes a bare path and leaves every explicit scope spelling alone', () => {
    expect(toolScopedViewPath(BARE_PERSONAL_PATH, true)).toBe(`personal/${BARE_PERSONAL_PATH}`)
    expect(toolScopedViewPath('偏好.md', true)).toBe('personal/偏好.md')
    // Localized alias is already canonical after resolveScopeAlias.
    expect(toolScopedViewPath('个人/偏好.md', true)).toBe('personal/偏好.md')
    expect(toolScopedViewPath('personal/偏好.md', true)).toBe('personal/偏好.md')
    expect(toolScopedViewPath('global/制度/采购.md', true)).toBe('global/制度/采购.md')
    expect(toolScopedViewPath('department/data-platform/制度.md', true)).toBe('department/data-platform/制度.md')
    // Local deployments keep the flat tree; there is no bucket to add.
    expect(toolScopedViewPath(BARE_PERSONAL_PATH, false)).toBe(BARE_PERSONAL_PATH)
    expect(toolScopedViewPath('', true)).toBe('')
  })

  it('adds the owner segment for authoritative writes and is idempotent', () => {
    expect(toolScopedActualPath(BARE_PERSONAL_PATH, 'u1', true))
      .toBe('personal/u1/个人记忆图谱/记忆日志/2026-11-12.md')
    expect(toolScopedActualPath('personal/偏好.md', 'u1', true)).toBe('personal/u1/偏好.md')
    // Already authoritative (graph tools pass this shape) -> unchanged.
    expect(toolScopedActualPath('personal/u1/偏好.md', 'u1', true)).toBe('personal/u1/偏好.md')
    // Global and department behavior is untouched by this fix.
    expect(toolScopedActualPath('global/制度.md', 'u1', true)).toBe('global/制度.md')
    expect(toolScopedActualPath('department/data-platform/制度.md', 'u1', true))
      .toBe('department/data-platform/制度.md')
    expect(toolScopedActualPath(BARE_PERSONAL_PATH, 'u1', false)).toBe(BARE_PERSONAL_PATH)
  })

  it('keeps assertToolPath backward compatible unless a default scope is given', () => {
    expect(assertToolPath('a.md')).toBe('a.md')
    expect(assertToolPath('a.md', false, 'personal')).toBe('personal/a.md')
    expect(assertToolPath('global/a.md', false, 'personal')).toBe('global/a.md')
    expect(assertToolPath('部门/a.md', false, 'personal')).toBe('department/a.md')
    expect(assertToolPath('', true, 'personal')).toBe('')
  })
})

describe('kb_file tools pass the scoped path to the host', () => {
  it('writes a bare personal path into the personal bucket', async () => {
    const spies: ToolSpies = { created: [], overwritten: [], statted: [], trashed: [], moved: [] }

    const result = await executeTool(makeToolHost(spies), 'kb_file_write', {
      path: BARE_PERSONAL_PATH,
      content: '# 2026-11-12\n',
    })

    expect(result).toMatchObject({ ok: true, created: true })
    expect(spies.created).toEqual([`personal/${BARE_PERSONAL_PATH}`])
    expect(spies.statted).toEqual([`personal/${BARE_PERSONAL_PATH}`])
  })

  it('overwrites and deletes the personal view path, not a global copy', async () => {
    const spies: ToolSpies = { created: [], overwritten: [], statted: [], trashed: [], moved: [] }
    const host = makeToolHost(spies, { existing: true })

    await executeTool(host, 'kb_file_write', { path: BARE_PERSONAL_PATH, content: 'x', overwrite: true })
    expect(spies.overwritten).toEqual([`personal/${BARE_PERSONAL_PATH}`])

    await executeTool(host, 'kb_file_delete', { path: BARE_PERSONAL_PATH })
    expect(spies.trashed).toEqual([`personal/${BARE_PERSONAL_PATH}`])
  })

  it('does not rewrite explicit global or department paths', async () => {
    const spies: ToolSpies = { created: [], overwritten: [], statted: [], trashed: [], moved: [] }
    const host = makeToolHost(spies)

    await executeTool(host, 'kb_file_write', { path: 'global/制度/采购.md', content: 'x' })
    await executeTool(host, 'kb_file_write', { path: 'department/data-platform/制度.md', content: 'x' })
    await executeTool(host, 'kb_file_write', { path: '个人/偏好.md', content: 'x' })

    expect(spies.created).toEqual([
      'global/制度/采购.md',
      'department/data-platform/制度.md',
      'personal/偏好.md',
    ])
  })
})

describe('real personal tree: write, list and read a bare relative path', () => {
  async function teamConfig(): Promise<{ actualRoot: string; viewRoot: string; mountPoint: string; config: Config }> {
    const root = await tempRoot()
    const actualRoot = join(root, 'actual')
    const viewRoot = join(root, 'views')
    const mountPoint = join(viewRoot, 'u1')
    await mkdir(actualRoot, { recursive: true })
    await mkdir(mountPoint, { recursive: true })
    return {
      actualRoot,
      viewRoot,
      mountPoint,
      // `baseUrl` is what makes `isTeamDeployment` true (remote/team mode).
      config: { actualRoot, viewRoot, mountPoint, baseUrl: 'http://dataops.invalid' } as unknown as Config,
    }
  }

  it('writes to personal/<uid>, then lists and reads it from the view', async () => {
    const { actualRoot, viewRoot, mountPoint, config } = await teamConfig()
    const viewPath = toolScopedViewPath(BARE_PERSONAL_PATH, true)
    const actualPath = toolScopedActualPath(BARE_PERSONAL_PATH, 'u1', true)

    await createKnowledgeEntry(config, actualPath, {
      directory: false,
      content: '# 2026-11-12\n\n今天记住一件事。\n',
    })

    // The bug wrote an unowned top-level copy that the view rendered as global.
    await expect(stat(join(actualRoot, BARE_PERSONAL_PATH))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(actualRoot, actualPath), 'utf8')).toContain('今天记住一件事')

    // The view is built from grants; simulate the sync that makes the document visible.
    await syncView({ actualRoot, viewRoot, userId: 'u1' }, [{ relPath: actualPath }])

    const read = await readKnowledgeFile({} as never, config, viewPath)
    expect(read.kind).toBe('text')
    expect(read.kind === 'text' ? read.content : '').toContain('今天记住一件事')

    const folder = viewPath.slice(0, viewPath.lastIndexOf('/'))
    const entries = await listDirectory(mountPoint, join(mountPoint, ...folder.split('/')))
    expect(entries.map(entry => entry.relPath)).toContain(viewPath)
  })

  it('leaves an explicit global write and read unchanged', async () => {
    const { actualRoot, viewRoot, mountPoint, config } = await teamConfig()

    await createKnowledgeEntry(config, 'global/制度/采购.md', { directory: false, content: 'global body' })
    expect(await readFile(join(actualRoot, 'global/制度/采购.md'), 'utf8')).toBe('global body')

    await syncView({ actualRoot, viewRoot, userId: 'u1' }, [{ relPath: 'global/制度/采购.md' }])
    const read = await readKnowledgeFile({} as never, config, 'global/制度/采购.md')
    expect(read.kind).toBe('text')
    expect(read.kind === 'text' ? read.content : '').toBe('global body')

    const entries = await listDirectory(mountPoint, join(mountPoint, 'global', '制度'))
    expect(entries.map(entry => entry.relPath)).toContain('global/制度/采购.md')
  })
})
