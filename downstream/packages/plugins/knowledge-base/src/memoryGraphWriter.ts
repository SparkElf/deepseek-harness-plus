/**
 * Keeps the personal-memory graph manifest in sync with the memory files.
 *
 * The memory store owns the documents; this writer owns only
 * `<scopeRoot>/.graphs/personal-memory/graph.json`. It never rewrites a memory
 * document and never duplicates a node:
 *
 * ```text
 * 个人记忆图谱/记忆日志/2026-11-12.md  ->  node memory-个人记忆图谱-记忆日志-2026-11-12
 * 个人记忆图谱/偏好.md               ->  node memory-个人记忆图谱-偏好
 * 个人记忆图谱/SOP/指标口径排查.md    ->  node memory-个人记忆图谱-SOP-指标口径排查
 * ```
 *
 * Node ids are derived from the scope-relative path and kept stable across
 * writes, so edges added later (daily document -> derived aggregate / SOP) do not
 * dangle. Every manifest write is atomic and validated with `loadGraph` +
 * `validateGraph`; if validation fails the previous manifest is restored.
 *
 * The graph is lazy: the first access creates an empty, valid
 * `personal-memory/graph.json` so "no memories yet" still has a graph home.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-graph-writer
 */

import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeFileAtomic } from './memoryBindings.ts'
import {
  GraphLoadError,
  loadGraph,
  validateGraph,
  type GraphManifest,
  type GraphManifestNode,
} from './graphModel.ts'
import {
  MEMORY_FACT_FILE,
  MEMORY_LOG_DIR,
  MEMORY_PITFALL_FILE,
  MEMORY_PREFERENCE_FILE,
  MEMORY_SOP_DIR,
} from './memoryStore.ts'
import { isSafeMemorySlug } from './memoryTypes.ts'

/** Default memory tree folder inside a personal scope. */
export const PERSONAL_MEMORY_FOLDER = '个人记忆图谱'
/** Default graph id, matching the design's `personal-memory/graph.json`. */
export const PERSONAL_MEMORY_GRAPH_ID = 'personal-memory'

/** Writer construction options. */
export interface MemoryGraphWriterOptions {
  /** Personal scope root that owns `.graphs/`. */
  scopeRoot: string
  /** Memory tree relative to `scopeRoot`; defaults to `个人记忆图谱`. */
  memoryRoot?: string
  /** Graph directory id under `.graphs/`; defaults to `personal-memory`. */
  graphId?: string
  /** Manifest `scope` string; defaults to `personal`. */
  scope?: string
  now?: () => Date
}

/** Result of one manifest reconciliation. */
export interface PersonalMemoryGraphResult {
  /** Absolute path of `graph.json`. */
  graphPath: string
  /** Node count after the operation. */
  nodeCount: number
  /** True when the manifest was rewritten. */
  changed: boolean
}

export type MemoryGraphWriterErrorCode = 'invalid-option' | 'unsafe-path' | 'missing-memory-document' | 'invalid-graph'

export class MemoryGraphWriterError extends Error {
  readonly code: MemoryGraphWriterErrorCode

  constructor(code: MemoryGraphWriterErrorCode, message: string) {
    super(message)
    this.name = 'MemoryGraphWriterError'
    this.code = code
  }
}

const isErrnoCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null
  && 'code' in error
  && (error as { code?: unknown }).code === code

/** A `/`-separated relative path with no empty, `.` or `..` segment. */
function isSafeRelativePath(value: string): boolean {
  if (value === '' || value.includes('\0') || value.includes('\\')) return false
  if (value.startsWith('/') || /^[A-Za-z]:\//u.test(value)) return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/** Deterministic id from a scope-relative document path. */
function nodeIdFor(scopePath: string): string {
  const stem = scopePath.replace(/\.md$/iu, '')
  const cleaned = stem.replace(/[^A-Za-z0-9\u4e00-\u9fff_-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return `memory-${cleaned === '' ? 'document' : cleaned}`
}

const isEmptyDocument = (name: string): boolean =>
  name.startsWith('.') || !name.toLowerCase().endsWith('.md')

/** Keep only manifest nodes under one memory root. */
const isUnder = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`)

/**
 * Owns one personal-memory `graph.json`.
 *
 * A single writer is assumed (the guardian session); `registerPath` is the
 * incremental hook after a store write, `removePath` after a SOP delete, and
 * `syncAll` is the reconciliation pass that can be run at any time.
 */
export class MemoryGraphWriter {
  private readonly scopeRoot: string
  private readonly memoryRoot: string
  private readonly graphId: string
  private readonly scope: string
  private readonly clock: () => Date

  constructor(options: MemoryGraphWriterOptions) {
    if (typeof options.scopeRoot !== 'string' || options.scopeRoot.trim() === '') {
      throw new MemoryGraphWriterError('invalid-option', 'scopeRoot must be a non-empty path')
    }
    const memoryRoot = options.memoryRoot ?? PERSONAL_MEMORY_FOLDER
    if (!isSafeRelativePath(memoryRoot)) {
      throw new MemoryGraphWriterError('invalid-option', `memoryRoot must be a safe relative path, got ${JSON.stringify(memoryRoot)}`)
    }
    const graphId = options.graphId ?? PERSONAL_MEMORY_GRAPH_ID
    if (!isSafeMemorySlug(graphId)) {
      throw new MemoryGraphWriterError('invalid-option', `graphId must be one safe path segment, got ${JSON.stringify(graphId)}`)
    }
    const scope = options.scope ?? 'personal'
    if (typeof scope !== 'string' || scope.trim() === '') {
      throw new MemoryGraphWriterError('invalid-option', 'scope must be a non-empty string')
    }
    this.scopeRoot = resolve(options.scopeRoot)
    this.memoryRoot = memoryRoot
    this.graphId = graphId
    this.scope = scope
    this.clock = options.now ?? ((): Date => new Date())
  }

  /** Absolute manifest path owned by this writer. */
  get graphPath(): string {
    return join(this.scopeRoot, '.graphs', this.graphId, 'graph.json')
  }

  /** Absolute root of the memory documents. */
  get memoryPath(): string {
    return join(this.scopeRoot, ...this.memoryRoot.split('/'))
  }

  /** Create an empty, valid graph on first access; idempotent afterwards. */
  async ensureGraph(): Promise<PersonalMemoryGraphResult> {
    const existing = await this.tryLoadManifest()
    if (existing !== undefined) {
      return { graphPath: this.graphPath, nodeCount: existing.nodes.length, changed: false }
    }
    const manifest = this.emptyManifest()
    await this.writeManifest(manifest)
    return { graphPath: this.graphPath, nodeCount: 0, changed: true }
  }

  /**
   * Register one document that the store just wrote.
   *
   * `memoryRelativePath` is relative to the memory root (for example
   * `记忆日志/2026-11-12.md` or `SOP/指标口径排查.md`). The file must exist: a
   * manifest node pointing at nothing is a validator error.
   */
  async registerPath(memoryRelativePath: string): Promise<PersonalMemoryGraphResult> {
    if (typeof memoryRelativePath !== 'string' || !isSafeRelativePath(memoryRelativePath) || isEmptyDocument(memoryRelativePath)) {
      throw new MemoryGraphWriterError(
        'unsafe-path',
        `memory path must be a safe .md path relative to the memory root, got ${JSON.stringify(memoryRelativePath)}`,
      )
    }
    const absolute = join(this.memoryPath, ...memoryRelativePath.split('/'))
    if (!(await this.isFile(absolute))) {
      throw new MemoryGraphWriterError('missing-memory-document', `memory document ${memoryRelativePath} does not exist`)
    }
    const scopePath = `${this.memoryRoot}/${memoryRelativePath}`
    const manifest = (await this.tryLoadManifest()) ?? this.emptyManifest()
    const desired = new Set(this.memoryPathsOf(manifest))
    desired.add(scopePath)
    return this.reconcile(manifest, desired)
  }

  /** Drop one document node and any edge that referenced it. */
  async removePath(memoryRelativePath: string): Promise<PersonalMemoryGraphResult> {
    if (typeof memoryRelativePath !== 'string' || !isSafeRelativePath(memoryRelativePath)) {
      throw new MemoryGraphWriterError('unsafe-path', `memory path is not safe: ${JSON.stringify(memoryRelativePath)}`)
    }
    const scopePath = `${this.memoryRoot}/${memoryRelativePath}`
    const manifest = (await this.tryLoadManifest()) ?? this.emptyManifest()
    const desired = new Set(this.memoryPathsOf(manifest))
    desired.delete(scopePath)
    return this.reconcile(manifest, desired)
  }

  /**
   * Reconcile the manifest with the memory files that exist on disk.
   *
   * Adds nodes for new files, removes nodes whose memory document disappeared,
   * and drops edges that would no longer resolve. Nodes outside the memory root
   * are left alone; the manifest stays `validateGraph`-clean.
   */
  async syncAll(): Promise<PersonalMemoryGraphResult> {
    const existing = await this.tryLoadManifest()
    const manifest = existing ?? this.emptyManifest()
    return this.reconcile(manifest, new Set(await this.scanMemoryPaths()), existing === undefined)
  }

  private memoryPathsOf(manifest: GraphManifest): string[] {
    return manifest.nodes
      .map(node => node.path)
      .filter(path => isUnder(path, this.memoryRoot))
  }

  private async scanMemoryPaths(): Promise<string[]> {
    const paths: string[] = []
    for (const file of [MEMORY_PREFERENCE_FILE, MEMORY_PITFALL_FILE, MEMORY_FACT_FILE]) {
      if (await this.isFile(join(this.memoryPath, file))) paths.push(`${this.memoryRoot}/${file}`)
    }
    for (const folder of [MEMORY_LOG_DIR, MEMORY_SOP_DIR]) {
      const directory = join(this.memoryPath, ...folder.split('/'))
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) continue
        throw error
      }
      for (const entry of entries) {
        if (!entry.isFile() || isEmptyDocument(entry.name)) continue
        if (folder === MEMORY_SOP_DIR && !isSafeMemorySlug(entry.name.slice(0, -3))) continue
        paths.push(`${this.memoryRoot}/${folder}/${entry.name}`)
      }
    }
    return paths.sort()
  }

  private async reconcile(
    manifest: GraphManifest,
    desiredMemoryPaths: Set<string>,
    forceCreate = false,
  ): Promise<PersonalMemoryGraphResult> {
    const externalNodes = manifest.nodes.filter(node => !isUnder(node.path, this.memoryRoot))
    const existingMemoryNodes = new Map(
      manifest.nodes
        .filter(node => isUnder(node.path, this.memoryRoot))
        .map(node => [node.path, node] as const),
    )
    const usedIds = new Map<string, string>()
    for (const node of [...externalNodes, ...existingMemoryNodes.values()]) usedIds.set(node.id, node.path)

    const memoryNodes: GraphManifestNode[] = []
    for (const path of [...desiredMemoryPaths].sort()) {
      const existing = existingMemoryNodes.get(path)
      if (existing !== undefined) {
        memoryNodes.push(existing)
        continue
      }
      let id = nodeIdFor(path)
      let suffix = 2
      while (usedIds.has(id) && usedIds.get(id) !== path) {
        id = `${nodeIdFor(path)}-${String(suffix)}`
        suffix += 1
      }
      usedIds.set(id, path)
      memoryNodes.push({ id, path })
    }

    const nodes = [...externalNodes, ...memoryNodes].sort((left, right) => (
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    ))
    const nodeIds = new Set(nodes.map(node => node.id))
    const edges = manifest.edges.filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    const changed = forceCreate
      || JSON.stringify(nodes) !== JSON.stringify(manifest.nodes)
      || JSON.stringify(edges) !== JSON.stringify(manifest.edges)
    if (!changed) {
      return { graphPath: this.graphPath, nodeCount: nodes.length, changed: false }
    }

    const next: GraphManifest = {
      ...manifest,
      version: manifest.version + 1,
      updatedAt: this.clock().toISOString(),
      nodes,
      edges,
    }
    await this.writeManifest(next)
    return { graphPath: this.graphPath, nodeCount: nodes.length, changed: true }
  }

  private emptyManifest(): GraphManifest {
    const now = this.clock().toISOString()
    return {
      schemaVersion: 1,
      id: this.graphId,
      name: '个人记忆图谱',
      description: '个人记忆：记忆日志、偏好、踩坑、事实与 SOP',
      scope: this.scope,
      version: 1,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      tags: [],
      visibility: 'private',
      defaultView: { layout: 'hierarchy', direction: 'TB' },
      topics: [
        { id: 'memory-log', title: '记忆日志' },
        { id: 'preferences', title: '偏好' },
        { id: 'pitfalls', title: '踩坑' },
        { id: 'facts', title: '事实' },
        { id: 'sops', title: 'SOP' },
      ],
      nodes: [],
      edges: [],
    }
  }

  private async tryLoadManifest(): Promise<GraphManifest | undefined> {
    try {
      const loaded = await loadGraph(this.scopeRoot, this.graphId)
      return loaded.manifest
    } catch (error) {
      if (error instanceof GraphLoadError && error.code === 'manifest-missing') return undefined
      throw error
    }
  }

  private async writeManifest(manifest: GraphManifest): Promise<void> {
    const previous = await readFile(this.graphPath, 'utf8').catch((error: unknown) => {
      if (isErrnoCode(error, 'ENOENT')) return undefined
      throw error
    })
    await writeFileAtomic(this.graphPath, `${JSON.stringify(manifest, null, 2)}\n`)
    try {
      const loaded = await loadGraph(this.scopeRoot, this.graphId)
      const errors = validateGraph(loaded)
      if (errors.length > 0) {
        throw new MemoryGraphWriterError(
          'invalid-graph',
          `generated personal-memory manifest failed validation: ${errors[0]?.message ?? 'unknown'}`,
        )
      }
    } catch (error) {
      // Never leave a manifest the rest of the product refuses to load.
      if (previous === undefined) await rm(this.graphPath, { force: true }).catch(() => undefined)
      else await writeFileAtomic(this.graphPath, previous).catch(() => undefined)
      if (error instanceof MemoryGraphWriterError) throw error
      throw new MemoryGraphWriterError(
        'invalid-graph',
        `generated personal-memory manifest could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async isFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile()
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) return false
      throw error
    }
  }
}

/** Convenience one-shot reconciliation for wiring. */
export async function syncPersonalMemoryGraph(options: MemoryGraphWriterOptions): Promise<PersonalMemoryGraphResult> {
  return new MemoryGraphWriter(options).syncAll()
}
