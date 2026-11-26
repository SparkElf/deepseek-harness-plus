/**
 * Ensure the personal memory graph exists.
 *
 * The graph tab is a catalogue of `.graphs/<id>/graph.json` manifests. A user
 * with no subscriptions yet has no personal graph at all, which reads as "the
 * memory feature is missing" rather than "there is nothing in it". This creates
 * an empty, private, published manifest for the caller once; it is the stable
 * home the guardian will later fill with subscription proxies and internalized
 * branches.
 *
 * Writing is deliberately best-effort at the call site: a read-only mount must
 * keep the graph tab usable, so a failed bootstrap is not an error for the route.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-graph-bootstrap
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Stable graph id for the caller's personal memory graph. */
export const PERSONAL_MEMORY_GRAPH_ID = 'personal-memory'

/** Display name shown in the graph tree. */
export const PERSONAL_MEMORY_GRAPH_NAME = '个人记忆图谱'

/** One empty manifest as it is written to disk. */
export interface PersonalMemoryGraphManifest {
  schemaVersion: 1
  id: string
  name: string
  description: string
  scope: string
  version: number
  status: 'draft' | 'published'
  owner: string
  createdAt: string
  updatedAt: string
  publishedAt: string
  tags: string[]
  visibility: 'private'
  defaultView: { layout: string; direction: string }
  topics: unknown[]
  nodes: unknown[]
  edges: unknown[]
}

/** One safe path segment, or undefined when it cannot be used as a file/dir name. */
function safeSegment(value: string): string | undefined {
  if (value === '' || value === '.' || value === '..') return undefined
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) return undefined
  return value
}

/** The manifest a fresh personal memory graph holds. */
export function emptyPersonalMemoryManifest(userId: string, now: string): PersonalMemoryGraphManifest {
  return {
    schemaVersion: 1,
    id: PERSONAL_MEMORY_GRAPH_ID,
    name: PERSONAL_MEMORY_GRAPH_NAME,
    description: '个人订阅代理与内化记忆的默认图谱；尚未订阅或内化任何部门节点。',
    scope: 'personal:' + userId,
    version: 1,
    status: 'published',
    owner: userId,
    createdAt: now,
    updatedAt: now,
    publishedAt: now,
    tags: ['记忆'],
    visibility: 'private',
    defaultView: { layout: 'hierarchy', direction: 'TB' },
    topics: [],
    nodes: [],
    edges: [],
  }
}

/** Whether one path is a regular file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Create `<scopeRoot>/.graphs/personal-memory/graph.json` when it is absent.
 *
 * @param options.scopeRoot - absolute personal scope root (`<actualRoot>/personal/<uid>`).
 * @param options.userId - stable caller id; also the manifest owner.
 * @param options.now - injectable clock for tests.
 * @returns whether the manifest was created and its absolute path.
 */
export async function ensurePersonalMemoryGraph(options: {
  scopeRoot: string
  userId: string
  now?: string
}): Promise<{ created: boolean; path: string }> {
  const userId = safeSegment(options.userId)
  if (userId === undefined) throw new Error('memory-graph: unsafe userId')
  const graphId = safeSegment(PERSONAL_MEMORY_GRAPH_ID)
  if (graphId === undefined) throw new Error('memory-graph: unsafe graph id')
  const directory = join(options.scopeRoot, '.graphs', graphId)
  const path = join(directory, 'graph.json')
  if (await isFile(path)) return { created: false, path }

  const manifest = emptyPersonalMemoryManifest(userId, options.now ?? new Date().toISOString())
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, '.graph.json.' + String(process.pid) + '.tmp')
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  await rename(temporary, path)
  return { created: true, path }
}

/** Read the personal memory manifest when it exists, for tests and diagnostics. */
export async function readPersonalMemoryGraph(scopeRoot: string): Promise<PersonalMemoryGraphManifest | undefined> {
  const path = join(scopeRoot, '.graphs', PERSONAL_MEMORY_GRAPH_ID, 'graph.json')
  try {
    return JSON.parse(await readFile(path, 'utf8')) as PersonalMemoryGraphManifest
  } catch {
    return undefined
  }
}
