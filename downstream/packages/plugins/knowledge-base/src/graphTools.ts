/**
 * Model-facing knowledge-graph tools (`kg_add` / `kg_get` / `kg_set` / `kg_del`).
 *
 * The four verbs mirror `kg.py`'s CLI. Two storage layouts are addressed through
 * the same Host seam the HTTP routes use: one grant per graph, `canWrite` before
 * every write, `readText` for every read, audit entries recorded beside the
 * caller's view, and `_trash` instead of deletion.
 *
 * - **Legacy folder graphs** (`<scope>/知识图谱/<graph>/<topic>/index.md`, relations
 *   under `.kg/links/`) keep their original behaviour untouched.
 * - **`.graphs/<id>/graph.json` graphs** (`format: 'graph-json'`) carry topology in
 *   the manifest and attributes in each node document's front matter. The tools
 *   read both, refuse duplicate ids / unknown endpoints / unsafe paths, and write
 *   the manifest through a temp-file rename; after every write the loaded graph is
 *   re-validated and the change is rolled back when the validator reports an error.
 *
 * Writes are two-step by design. A call without `confirm: true` returns the exact
 * draft it would write and changes nothing; the model shows that draft to the user
 * and calls again with `confirm: true` after approval. This is the §7 trigger rule
 * (user sovereignty) expressed in the tool protocol rather than in a hook.
 *
 * `kg_add` also creates a graph: `kind: 'graph'` writes a new
 * `.graphs/<id>/graph.json` under the caller's writable scope, so a model can seed
 * a knowledge graph instead of being stuck at "no readable graph". Creating a graph
 * follows the same draft → confirm protocol, id validation, `canWrite` check and
 * audit record as every other write.
 *
 * @module @sparkelf/dsh-knowledge-base/graph-tools
 */

import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  asKnowledgeToolError,
  KnowledgeToolError,
  type KnowledgeFileToolHost,
} from './knowledgeTools.ts'
import type { KnowledgeAuditEntry } from './views.ts'
import {
  bodyAfterSummary,
  firstSummary,
  parseGraphFrontMatter,
  parseGraphList,
} from './graph.ts'
import {
  parseNodeFrontMatter,
  validateGraph,
  type GraphManifest,
  type GraphManifestEdge,
  type GraphManifestNode,
  type GraphNodeAttributes,
  type GraphValidationIssue,
  type LoadedGraph,
  type LoadedGraphEdge,
  type LoadedGraphNode,
  type MemoryAuthority,
  type MemoryNodeType,
  type MemoryOrigin,
  type MemoryReviewStatus,
} from './graphModel.ts'
import {
  KNOWLEDGE_GRAPH_FOLDER,
  type KnowledgeGraphLink,
  type KnowledgeGraphNode,
  type KnowledgeGraphTopic,
} from './graphTypes.ts'
import { scopeFromAlias } from './scopeAliases.ts'

/** The Host operations graph tools compose. Actual paths are authoritative. */
export interface KnowledgeGraphToolHost extends Pick<
  KnowledgeFileToolHost,
  'resolveCaller' | 'canWrite' | 'createEntry' | 'overwriteFile' | 'moveEntry' | 'statEntry' | 'refreshView' | 'appendAudit' | 'viewDir'
> {
  /** Every graph the caller may read, with Host-only `actualPath`. */
  listGraphs(): Promise<KnowledgeGraphNode[]>
  /**
   * Resolve the caller with the department chain, for the inheritance model.
   *
   * Optional so unit-test hosts and one-shot callers keep working; without it the
   * department contribution set is empty (only personal and global graphs appear).
   */
  resolveGraphCaller?(): Promise<{
    userId: string
    label?: string
    departmentPathCodes?: string[]
    departmentPathNames?: string[]
  }>
  /** Read one view-relative document through the permission-checked route. */
  readText(viewPath: string): Promise<string>
  /**
   * Read one knowledge-root-relative path that may be hidden from the view tree
   * (`.graphs/<id>/graph.json`, relation docs). The Host applies the same path
   * permission check as {@link readText}; absent means the Host cannot read
   * hidden paths and the tool falls back to the view spelling.
   */
  readActual?(relPath: string): Promise<string>
  /** Stat one knowledge-root-relative path, for the hidden `.graphs` store. */
  statActual?(relPath: string): Promise<{ kind: 'file' | 'directory'; size?: number } | undefined>
  /**
   * Lifecycle owner for the computed overview stores.
   *
   * Absent in unit tests and one-shot hosts, where each read opens a transient
   * JSON store; the real Host wires one manager per plugin instance so global and
   * department stores are shared and a personal store is per user.
   */
  overviewStores?: OverviewStoreManager
}

const jsonOutput = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: JSON.stringify(value, null, 2),
  }],
}

const run = async (operation: () => Promise<Record<string, any>>): Promise<Record<string, any>> => {
  try {
    return await operation()
  } catch (error) {
    throw asKnowledgeToolError(error)
  }
}

/** The model-facing hint that turns a missing graph into a next step. */
function graphCreateHint(id = '<graph-id>', name = '<图谱名称>'): string {
  return 'kg_add {"kind":"graph","scope":"personal","id":' + JSON.stringify(id)
    + ',"name":' + JSON.stringify(name) + '}'
}

/**
 * Resolve a short overview spelling.
 *
 * `null` means the bare `总图` / `__overview__`, which prefers the caller's
 * personal overview. A level means `global/__overview__` or
 * `department/总图`-style spelling. `undefined` means "not an overview alias".
 */
function overviewAliasLevel(value: string): OverviewLevel | null | undefined {
  const needle = value.trim()
  if (needle === OVERVIEW_GRAPH_ID || needle === OVERVIEW_GRAPH_NAME) return null
  for (const level of OVERVIEW_LEVELS) {
    if (needle === level + '/' + OVERVIEW_GRAPH_ID || needle === level + '/' + OVERVIEW_GRAPH_NAME) {
      return level
    }
  }
  return undefined
}

/** Resolve one graph by id, path or unique name. */
function requireGraph(graphs: readonly KnowledgeGraphNode[], value: string): KnowledgeGraphNode {
  const needle = value.trim()
  // The three computed overviews are addressed by their reserved id, a
  // `<level>/__overview__` spelling, or their shared display name. Their canonical
  // path also matches the generic lookup below.
  const alias = overviewAliasLevel(needle)
  if (alias !== undefined) {
    const overviews = graphs.filter(isOverviewGraph)
    const match = alias === null
      ? (overviews.find(graph => graph.scope === 'personal')
        ?? (overviews.length === 1 ? overviews[0] : undefined))
      : overviews.find(graph => graph.scope === alias)
    if (match !== undefined) return match
    if (alias === null && overviews.length > 1) {
      throw new KnowledgeToolError(
        'invalid',
        'there are several overview graphs; pass global/__overview__, department/__overview__ or personal/__overview__',
      )
    }
  }
  const found = graphs.filter(graph => graph.id === needle || graph.path === needle || graph.name === needle)
  if (found.length === 1) return found[0]!
  if (found.length === 0) {
    // The needle may be a display name or a path; only a value that is already a
    // legal graph id can be reused as the id in the example.
    const idHint = GRAPH_ITEM_ID.test(needle) ? needle : '<graph-id>'
    const nameHint = needle.includes('/') ? '<图谱名称>' : needle
    throw new KnowledgeToolError(
      'not-found',
      'no readable graph matches ' + JSON.stringify(needle)
        + '. Create it first: ' + graphCreateHint(idHint, nameHint)
        + ' returns a draft, and calling it again with confirm:true writes .graphs/<id>/graph.json; '
        + 'then retry with graph="personal/.graphs/<id>"',
    )
  }
  throw new KnowledgeToolError('invalid', 'the graph name is ambiguous; pass its path: '
    + found.map(graph => graph.path).join(', '))
}

/** Resolve one topic inside a graph by id or folder name. */
function requireTopic(graph: KnowledgeGraphNode, value: string): KnowledgeGraphTopic {
  const needle = value.trim()
  const found = graph.topics.filter(topic => topic.id === needle || topic.folder === needle)
  if (found.length === 1) return found[0]!
  if (found.length === 0) throw new KnowledgeToolError('not-found', 'no topic matches ' + JSON.stringify(needle) + ' in ' + graph.name)
  throw new KnowledgeToolError('invalid', 'the topic id is ambiguous in ' + graph.name)
}

/** Actual path of a graph, refusing a node the scanner did not anchor. */
function actualGraphPath(graph: KnowledgeGraphNode): string {
  if (graph.actualPath === undefined || graph.actualPath === '') {
    throw new KnowledgeToolError('not-configured', 'the graph has no authoritative path')
  }
  return graph.actualPath
}

/** Actual path of one topic folder. */
function topicActualPath(graph: KnowledgeGraphNode, topic: KnowledgeGraphTopic): string {
  return actualGraphPath(graph) + '/' + topic.folder
}

/** Today as `YYYY-MM-DD`. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Render one topic card. */
function renderCard(input: {
  id: string
  title: string
  status: string
  depth: number
  domain: string
  summary: string
  body: string
  updated?: string
}): string {
  return [
    '---',
    `id: ${input.id}`,
    `title: ${input.title}`,
    `status: ${input.status}`,
    `depth: ${input.depth}`,
    `domain: ${input.domain}`,
    `updated: ${input.updated ?? today()}`,
    '---',
    '',
    `# ${input.title}`,
    '',
    input.summary.trim(),
    '',
    input.body.trim(),
    '',
  ].join('\n')
}

/** Render one relation document. */
function renderLink(input: { a: string; b: string; label?: string; body: string }): string {
  return [
    '---',
    `a: ${input.a}`,
    `b: ${input.b}`,
    ...(input.label === undefined || input.label.trim() === '' ? [] : [`label: ${input.label.trim()}`]),
    `updated: ${today()}`,
    '---',
    '',
    `# ${input.label?.trim() || input.a + ' ↔ ' + input.b}`,
    '',
    input.body.trim(),
    '',
  ].join('\n')
}

/** The view-relative path a tool result may expose. */
function topicViewPath(graph: KnowledgeGraphNode, topic: KnowledgeGraphTopic): string {
  return graph.path + '/' + topic.folder
}

/** Record one graph action beside the caller's view. */
async function recordAudit(
  host: KnowledgeGraphToolHost,
  caller: { userId: string; label?: string },
  entry: Omit<KnowledgeAuditEntry, 'at' | 'actor' | 'actorLabel'>,
): Promise<{ written: boolean; reason?: string }> {
  try {
    await host.appendAudit(host.viewDir(caller.userId), {
      at: new Date().toISOString(),
      actor: caller.userId,
      ...(caller.label === undefined ? {} : { actorLabel: caller.label }),
      ...entry,
    })
    return { written: true }
  } catch (error) {
    return { written: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Validate a status value. */
function requireStatus(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (value !== 'active' && value !== 'paused' && value !== 'done') {
    throw new KnowledgeToolError('invalid', 'status must be active, paused or done')
  }
  return value
}

/** Validate a depth value. */
function requireDepth(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const depth = Number(value)
  if (!Number.isInteger(depth) || depth < 1 || depth > 5) {
    throw new KnowledgeToolError('invalid', 'depth must be an integer from 1 to 5')
  }
  return depth
}

/** One topic as the summary list returns it. */
function topicSummary(graph: KnowledgeGraphNode, topic: KnowledgeGraphTopic): Record<string, unknown> {
  return {
    id: topic.id,
    title: topic.title,
    status: topic.status,
    depth: topic.depth,
    summary: topic.summary,
    path: topicViewPath(graph, topic),
    documents: topic.documents.length,
    relations: graph.links.filter(link => link.a === topic.id || link.b === topic.id).length,
  }
}

// ---------------------------------------------------------------------------
// `.graphs/<id>/graph.json` graphs (`format: 'graph-json'`)
// ---------------------------------------------------------------------------

/**
 * `readText` returns the Host preview window; anything larger is truncated.
 * Refusing an oversized document is the only safe answer: rewriting the visible
 * head would silently drop the tail of a node body or a manifest.
 */
const GRAPH_JSON_TEXT_LIMIT = 256 * 1024

/** A node/edge id is one safe path segment and one relation-file stem. */
const GRAPH_ITEM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u

const NODE_TYPES: readonly MemoryNodeType[] = ['policy', 'fact', 'procedure', 'case', 'skill', 'decision', 'topic']
const AUTHORITIES: readonly MemoryAuthority[] = ['canonical', 'advisory', 'redline']
const ORIGINS: readonly MemoryOrigin[] = ['human', 'ai', 'mixed']
const REVIEW_STATUSES: readonly MemoryReviewStatus[] = ['draft', 'reviewed', 'approved']

/** The scopes a new graph may be created in; a department chain may also be given exactly. */
const GRAPH_CREATE_SCOPES = ['personal', 'department', 'global'] as const
type GraphCreateScopeKey = (typeof GRAPH_CREATE_SCOPES)[number]

/** One resolved create target: where `.graphs/<id>` goes and what the manifest records. */
interface GraphCreateTarget {
  key: GraphCreateScopeKey
  /** View-relative scope base, e.g. `personal` or `department/D1/D2`. */
  viewBase: string
  /** Authoritative scope base; gains the owner segment for the personal scope. */
  actualBase: string
  /** Manifest `scope` value, e.g. `personal:u1` or `department:D1/D2`. */
  manifestScope: string
  /** Manifest `visibility`, derived from the scope. */
  visibility: 'private' | 'department' | 'global'
}

/** A graph node as the Projection publishes it: `format` is a runtime-only tag. */
type GraphNodeWithFormat = KnowledgeGraphNode & { format?: string }

/** The `.graphs/<id>` coordinates one graph-json graph is addressed in. */
interface GraphJsonStore {
  graph: KnowledgeGraphNode
  /** `.graphs/<id>` directory name (the manifest id is checked against it). */
  graphId: string
  /** View-relative scope base, e.g. `personal`. */
  viewBase: string
  /** Authoritative scope base, e.g. `personal/<uid>`. */
  actualBase: string
  /** View-relative store, e.g. `personal/.graphs/procurement`. */
  viewStorePath: string
  /** Authoritative store, e.g. `personal/<uid>/.graphs/procurement`. */
  actualStorePath: string
}

/** One loaded `.graphs` graph: manifest, nodes, edges and loader issues. */
interface GraphJsonState {
  store: GraphJsonStore
  /** The manifest object exactly as parsed, so unknown fields survive a rewrite. */
  raw: Record<string, unknown>
  manifest: GraphManifest
  nodes: LoadedGraphNode[]
  edges: LoadedGraphEdge[]
  issues: GraphValidationIssue[]
  manifestText: string
}

/** A manifest replacement that can be undone. */
interface ManifestCommit {
  previousText: string
  backupPath: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A manifest timestamp / trash suffix, safe as one path segment. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, '-')
}

function isSafeSegment(value: string): boolean {
  return value !== '' && value !== '.' && value !== '..' && !value.includes('\\') && !value.includes('\0')
}

/** Whether a value is a portable `/`-separated path that cannot escape its root. */
function isSafeRelPath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || value.includes('\\')) return false
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)) return false
  return value.split('/').every(isSafeSegment)
}

/** Whether a value may be a node body path: a visible `.md` document in the scope. */
function isSafeNodePath(value: unknown): value is string {
  if (!isSafeRelPath(value) || !value.toLowerCase().endsWith('.md')) return false
  const segments = value.split('/')
  // `.graphs`, `.kg`, `.archive` and `_trash` are plumbing, never node bodies.
  if (segments.some(segment => segment.startsWith('.'))) return false
  return !segments.some(segment => segment === '_trash')
}

/** Join a scope base with a scope-relative path, keeping `/` separators. */
function joinRel(base: string, relPath: string): string {
  return base === '' ? relPath : base + '/' + relPath
}

/** Split a `<base>/.graphs/<id>` path into base and id; undefined when it is not one. */
function storePathParts(value: string): { base: string; id: string } | undefined {
  const parts = value.split('/')
  if (parts.length < 2 || parts[parts.length - 2] !== '.graphs') return undefined
  const id = parts[parts.length - 1] ?? ''
  if (!isSafeSegment(id)) return undefined
  return { base: parts.slice(0, -2).join('/'), id }
}

/**
 * The store coordinates of a graph, or undefined for a legacy folder graph.
 *
 * Only `format === 'graph-json'` is accepted: guessing from a path spelling would
 * let a legacy graph with a coincidentally similar name be written as a manifest.
 */
function graphJsonStore(graph: KnowledgeGraphNode): GraphJsonStore | undefined {
  if ((graph as GraphNodeWithFormat).format !== 'graph-json') return undefined
  const actualPath = actualGraphPath(graph)
  const actual = storePathParts(actualPath)
  const view = storePathParts(graph.path)
  if (actual === undefined) {
    throw new KnowledgeToolError('not-configured', 'the graph-json graph has no .graphs/<id> actual path', graph.path)
  }
  if (view === undefined) {
    throw new KnowledgeToolError('not-configured', 'the graph-json graph has no .graphs/<id> view path', graph.path)
  }
  return {
    graph,
    graphId: actual.id,
    viewBase: view.base,
    actualBase: actual.base,
    viewStorePath: graph.path,
    actualStorePath: actualPath,
  }
}

/** The title fallback the loader uses: the file name without its extension. */
function titleFromPath(relPath: string): string {
  const name = relPath.split('/').pop() ?? relPath
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name
}

function errorIssue(code: GraphValidationIssue['code'], message: string, ref?: string): GraphValidationIssue {
  return ref === undefined
    ? { severity: 'error', code, message }
    : { severity: 'error', code, message, ref }
}

function warningIssue(code: GraphValidationIssue['code'], message: string, ref?: string): GraphValidationIssue {
  return ref === undefined
    ? { severity: 'warning', code, message }
    : { severity: 'warning', code, message, ref }
}

function defaultNodeAttributes(id: string, title: string): GraphNodeAttributes {
  return {
    id,
    type: 'fact',
    title,
    authority: 'advisory',
    internalizable: true,
    origin: 'human',
    reviewStatus: 'draft',
    tags: [],
    sourceRefs: [],
  }
}

/** Read one view/actual document, trying both spellings of the same file. */
async function readTextEither(
  host: KnowledgeGraphToolHost,
  viewPath: string,
  actualPath: string,
): Promise<string> {
  // `.graphs/` is plumbing and may be excluded from the view tree, so the
  // authoritative reader is tried first when the Host exposes one. The view
  // spelling stays as the fallback for a Host whose view already links it.
  if (host.readActual !== undefined && actualPath !== viewPath) {
    try {
      return await host.readActual(actualPath)
    } catch {
      // fall through to the view spelling
    }
  }
  const candidates = viewPath === actualPath ? [viewPath] : [viewPath, actualPath]
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      return await host.readText(candidate)
    } catch (error) {
      lastError = error
    }
  }
  throw asKnowledgeToolError(lastError)
}

/** Read a document that lives at a scope-relative path. */
async function readScopeText(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
  relPath: string,
): Promise<string> {
  return readTextEither(host, joinRel(store.viewBase, relPath), joinRel(store.actualBase, relPath))
}

/** Read a file inside `.graphs/<id>` by its path relative to the store. */
async function readStoreText(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
  relPath: string,
): Promise<string> {
  return readTextEither(host, joinRel(store.viewStorePath, relPath), joinRel(store.actualStorePath, relPath))
}

/** Stat one authoritative document. A missing or unreadable path answers undefined. */
async function statFile(
  host: KnowledgeGraphToolHost,
  actualRelPath: string,
): Promise<{ kind: 'file' | 'directory'; size?: number } | undefined> {
  if (host.statActual !== undefined) {
    try {
      return await host.statActual(actualRelPath)
    } catch {
      return undefined
    }
  }
  try {
    return await host.statEntry(actualRelPath)
  } catch {
    return undefined
  }
}

/**
 * Split a document into front-matter lines and the body beneath the closing `---`.
 *
 * The body is kept as the raw remainder of the source, not re-joined line by
 * line: a front-matter-only edit must not normalise line endings or touch one
 * body byte.
 */
interface SplitDocument {
  hasBlock: boolean
  closed: boolean
  lines: string[]
  body: string
}

function splitDocument(source: string): SplitDocument {
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source
  const firstLineEnd = text.indexOf('\n')
  const firstLine = (firstLineEnd === -1 ? text : text.slice(0, firstLineEnd)).replace(/\r$/u, '').trimEnd()
  if (firstLine !== '---') return { hasBlock: false, closed: false, lines: [], body: text }
  const lines: string[] = []
  let offset = firstLineEnd + 1
  while (offset <= text.length) {
    const lineEnd = text.indexOf('\n', offset)
    const rawLine = lineEnd === -1 ? text.slice(offset) : text.slice(offset, lineEnd)
    const line = rawLine.replace(/\r$/u, '')
    if (line.trimEnd() === '---') {
      return {
        hasBlock: true,
        closed: true,
        lines,
        body: lineEnd === -1 ? '' : text.slice(lineEnd + 1),
      }
    }
    lines.push(line)
    if (lineEnd === -1) break
    offset = lineEnd + 1
  }
  return { hasBlock: true, closed: false, lines, body: text }
}

/** Remove an unquoted trailing ` # comment` from one front-matter value. */
function stripComment(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('"') || value.startsWith("'")) return value
  const match = /\s+#/u.exec(value)
  return match === null ? value : value.slice(0, match.index).trimEnd()
}

/** Unquote one single- or double-quoted scalar; undefined when the quotes do not balance. */
function unquoteScalar(raw: string): string | undefined {
  const value = raw.trim()
  if (value.length < 2) return undefined
  const quote = value[0]
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) return undefined
  const inner = value.slice(1, -1)
  if (quote === "'") return inner.replace(/''/gu, "'")
  let result = ''
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? ''
    if (char !== '\\') {
      result += char
      continue
    }
    const next = inner[index + 1]
    if (next === undefined) return undefined
    index += 1
    if (next === 'n') result += '\n'
    else if (next === 't') result += '\t'
    else if (next === 'r') result += '\r'
    else result += next
  }
  return result
}

/** Parse one `key: value` line per entry; the documented front-matter subset. */
function parseFrontMatterEntries(lines: readonly string[]): { values: Map<string, string>; errors: string[] } {
  const values = new Map<string, string>()
  const errors: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/^\s/u.test(line)) {
      errors.push(`line ${index + 1}: nested YAML collections are not supported`)
      continue
    }
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:[ \t]*(.*)$/u.exec(line)
    if (match === null) {
      errors.push(`line ${index + 1}: expected a "key: value" pair`)
      continue
    }
    const key = match[1] ?? ''
    if (values.has(key)) {
      errors.push(`line ${index + 1}: duplicate key "${key}"`)
      continue
    }
    values.set(key, (match[2] ?? '').trim())
  }
  return { values, errors }
}

/** Split `[a, "b, c"]` into its values; undefined when the array is malformed. */
function parseFlowArray(raw: string): string[] | undefined {
  const value = raw.trim()
  if (!value.startsWith('[') || !value.endsWith(']')) return undefined
  const inner = value.slice(1, -1).trim()
  if (inner === '') return []
  const items: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaped = false
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? ''
    if (quote === '"') {
      current += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quote = undefined
      continue
    }
    if (quote === "'") {
      current += char
      if (char === "'") {
        if (inner[index + 1] === "'") {
          current += inner[index + 1] ?? ''
          index += 1
        } else {
          quote = undefined
        }
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === ',') {
      items.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (quote !== undefined) return undefined
  items.push(current.trim())
  const values: string[] = []
  for (const item of items) {
    if (item === '') return undefined
    if (item.startsWith('"') || item.startsWith("'")) {
      const text = unquoteScalar(item)
      if (text === undefined) return undefined
      values.push(text)
      continue
    }
    if (item.includes('[') || item.includes(']')) return undefined
    values.push(item)
  }
  return values
}

/** Render a scalar for the front-matter subset, quoting anything that needs it. */
function yamlScalar(value: string): string {
  if (value === '') return '""'
  if (
    value.trim() === value
    && /^[A-Za-z0-9_\u4e00-\u9fff][^:#\n\r\t]*$/u.test(value)
    && !/^(?:true|false|null|~)$/iu.test(value)
  ) {
    return value
  }
  return JSON.stringify(value)
}

/** Render one inline array; an empty list stays `[]`. */
function renderStringArray(values: readonly string[]): string {
  return '[' + values.map(item => {
    if (item.trim() === item && /^[^,[\]'"#\n\r\t][^,[\]'"#\n\r\t]*$/u.test(item)) return item
    return JSON.stringify(item)
  }).join(', ') + ']'
}

/** Rewrite the managed keys of an existing front-matter block, preserving every other line. */
function rewriteFrontMatter(split: SplitDocument, fields: ReadonlyArray<readonly [string, string]>): string {
  const wanted = new Map(fields)
  const emitted = new Set<string>()
  const lines: string[] = []
  for (const line of split.lines) {
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:/u.exec(line)
    const key = match?.[1]
    if (key === undefined || !wanted.has(key)) {
      lines.push(line)
      continue
    }
    if (emitted.has(key)) continue
    emitted.add(key)
    lines.push(`${key}: ${wanted.get(key) ?? ''}`)
  }
  for (const [key, value] of fields) {
    if (emitted.has(key)) continue
    lines.push(`${key}: ${value}`)
  }
  return `---\n${lines.join('\n')}\n---\n${split.body}`
}

/** Render the canonical node front matter. */
function nodeFrontMatterFields(attributes: GraphNodeAttributes): Array<[string, string]> {
  return [
    ['id', yamlScalar(attributes.id)],
    ['type', attributes.type],
    ['title', yamlScalar(attributes.title)],
    ['authority', attributes.authority],
    ['internalizable', String(attributes.internalizable)],
    ['origin', attributes.origin],
    ['reviewStatus', attributes.reviewStatus],
    ['tags', renderStringArray(attributes.tags)],
    ['sourceRefs', renderStringArray(attributes.sourceRefs)],
  ]
}

/** Render a brand-new node document. */
function renderNodeDocument(attributes: GraphNodeAttributes, body: string): string {
  const fields = nodeFrontMatterFields(attributes).map(([key, value]) => `${key}: ${value}`)
  const text = body.trim()
  return `---\n${fields.join('\n')}\n---\n\n# ${attributes.title}\n\n${text}${text === '' ? '' : '\n'}`
}

/** Render a brand-new relation document. */
function renderEdgeDocument(input: {
  id: string
  from: string
  to: string
  type: string
  authority: MemoryAuthority
  internalizable: boolean
  origin: MemoryOrigin
  reviewStatus: MemoryReviewStatus
  title?: string
  tags?: readonly string[]
  sourceRefs?: readonly string[]
}, body: string): string {
  const fields = [
    `id: ${yamlScalar(input.id)}`,
    `from: ${yamlScalar(input.from)}`,
    `to: ${yamlScalar(input.to)}`,
    `type: ${yamlScalar(input.type)}`,
    `authority: ${input.authority}`,
    `internalizable: ${String(input.internalizable)}`,
    `origin: ${input.origin}`,
    `reviewStatus: ${input.reviewStatus}`,
  ]
  if (input.title !== undefined && input.title.trim() !== '') fields.splice(3, 0, `title: ${yamlScalar(input.title.trim())}`)
  if (input.tags !== undefined && input.tags.length > 0) fields.push(`tags: ${renderStringArray(input.tags)}`)
  if (input.sourceRefs !== undefined && input.sourceRefs.length > 0) fields.push(`sourceRefs: ${renderStringArray(input.sourceRefs)}`)
  const text = body.trim()
  return `---\n${fields.join('\n')}\n---\n${text === '' ? '' : '\n' + text + '\n'}`
}

/** The default relation-document path for one edge id. */
function edgeDocPath(graphId: string, edgeId: string): string {
  return `.graphs/${graphId}/links/${edgeId}.md`
}

/** Read one node body and merge its front matter with the manifest identity. */
async function loadGraphJsonNode(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
  manifestNode: GraphManifestNode,
): Promise<{ node: LoadedGraphNode; issues: GraphValidationIssue[] }> {
  const issues: GraphValidationIssue[] = []
  const fallback = defaultNodeAttributes(manifestNode.id, titleFromPath(manifestNode.path))
  if (!isSafeNodePath(manifestNode.path)) {
    issues.push(errorIssue(
      'path-escape',
      `node "${manifestNode.id}" path "${manifestNode.path}" is not a safe scope-relative document path`,
      manifestNode.path,
    ))
    return { node: { ...fallback, path: manifestNode.path, missing: true }, issues }
  }
  const actualPath = joinRel(store.actualBase, manifestNode.path)
  const info = await statFile(host, actualPath)
  if (info === undefined || info.kind !== 'file') {
    issues.push(errorIssue(
      'missing-node',
      `node "${manifestNode.id}" document "${manifestNode.path}" does not exist`,
      manifestNode.path,
    ))
    return { node: { ...fallback, path: manifestNode.path, missing: true }, issues }
  }
  if ((info.size ?? 0) > GRAPH_JSON_TEXT_LIMIT) {
    issues.push(errorIssue(
      'missing-node',
      `node "${manifestNode.id}" document "${manifestNode.path}" is larger than the ${String(GRAPH_JSON_TEXT_LIMIT)}-byte readable window`,
      manifestNode.path,
    ))
    return { node: { ...fallback, path: manifestNode.path, missing: true }, issues }
  }
  let source: string
  try {
    source = await readScopeText(host, store, manifestNode.path)
  } catch (error) {
    issues.push(errorIssue(
      'missing-node',
      `node "${manifestNode.id}" document "${manifestNode.path}" could not be read (${messageOf(error)})`,
      manifestNode.path,
    ))
    return { node: { ...fallback, path: manifestNode.path, missing: true }, issues }
  }
  const parsed = parseNodeDocument(source, manifestNode)
  issues.push(...parsed.issues)
  if (parsed.attributes.id !== manifestNode.id) {
    issues.push(warningIssue(
      'invalid-frontmatter',
      `node front matter id "${parsed.attributes.id}" does not match graph.json id "${manifestNode.id}"; graph.json wins`,
      manifestNode.path,
    ))
  }
  return {
    node: { ...parsed.attributes, id: manifestNode.id, path: manifestNode.path, missing: false },
    issues,
  }
}

/** Parse a node document, using the loader's fallbacks when it has no front matter. */
function parseNodeDocument(
  source: string,
  manifestNode: GraphManifestNode,
): { attributes: GraphNodeAttributes; body: string; issues: GraphValidationIssue[] } {
  const split = splitDocument(source)
  const fallback = defaultNodeAttributes(manifestNode.id, titleFromPath(manifestNode.path))
  const parsed = parseNodeFrontMatter(source)
  if (parsed.attributes !== null) {
    return { attributes: parsed.attributes, body: parsed.body, issues: parsed.issues }
  }
  // `loadGraph` treats an unannotated legacy document as a warning and fills the
  // defaults; only a present-but-invalid block is an error.
  const issues = split.hasBlock
    ? parsed.issues
    : parsed.issues.map(issue => ({ ...issue, severity: 'warning' as const }))
  return { attributes: fallback, body: split.body, issues }
}

interface EdgeAttributes {
  title: string
  authority: MemoryAuthority
  internalizable: boolean
  origin: MemoryOrigin
  reviewStatus: MemoryReviewStatus
  tags: string[]
  sourceRefs: string[]
  /** The relation type written in the document, when it has one. */
  relationType?: string
  /** The id written in the document, when it has one. */
  documentId?: string
}

/** Parse one optional relation document. Its `type` is a free-form relation label. */
function parseEdgeDocument(
  source: string,
  edge: GraphManifestEdge,
  docPath: string,
): { attributes: EdgeAttributes; body: string; issues: GraphValidationIssue[] } {
  const split = splitDocument(source)
  const attributes: EdgeAttributes = {
    title: edge.id,
    authority: 'advisory',
    internalizable: true,
    origin: 'human',
    reviewStatus: 'draft',
    tags: [],
    sourceRefs: [],
  }
  const issues: GraphValidationIssue[] = []
  if (!split.hasBlock) {
    issues.push(warningIssue(
      'invalid-frontmatter',
      `edge "${edge.id}" document has no front matter; defaults are used`,
      docPath,
    ))
    return { attributes, body: split.body, issues }
  }
  if (!split.closed) {
    issues.push(errorIssue(
      'invalid-frontmatter',
      `edge "${edge.id}" document front matter is not closed with ---`,
      docPath,
    ))
    return { attributes, body: split.body, issues }
  }

  const { values, errors } = parseFrontMatterEntries(split.lines)
  const fail = (message: string): void => {
    issues.push(errorIssue('invalid-frontmatter', `edge "${edge.id}" ${message}`, docPath))
  }
  for (const message of errors) fail(message)

  const readText = (key: string): string | undefined => {
    const raw = values.get(key)
    if (raw === undefined) return undefined
    const stripped = stripComment(raw)
    if (stripped.startsWith('"') || stripped.startsWith("'")) {
      const text = unquoteScalar(stripped)
      if (text === undefined) fail(`front matter "${key}" has unbalanced quotes`)
      return text
    }
    return stripped
  }
  const readArray = (key: string): string[] | undefined => {
    const raw = values.get(key)
    if (raw === undefined) return undefined
    const stripped = stripComment(raw)
    const items = parseFlowArray(stripped)
    if (items === undefined) fail(`front matter "${key}" must be an inline array such as [a, b]`)
    return items
  }
  const readEnum = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const raw = readText(key)
    if (raw === undefined) return fallback
    if (!(allowed as readonly string[]).includes(raw)) {
      fail(`front matter "${key}" must be one of ${allowed.join(', ')}`)
      return fallback
    }
    return raw as T
  }

  const documentId = readText('id')
  if (documentId !== undefined && documentId !== edge.id) {
    issues.push(warningIssue(
      'invalid-frontmatter',
      `edge front matter id "${documentId}" does not match graph.json id "${edge.id}"; graph.json wins`,
      docPath,
    ))
  }
  const relationType = readText('type')
  if (relationType !== undefined && relationType !== edge.type) {
    issues.push(warningIssue(
      'invalid-frontmatter',
      `edge front matter type "${relationType}" does not match graph.json type "${edge.type}"; graph.json wins`,
      docPath,
    ))
  }
  const internalizableRaw = readText('internalizable')
  let internalizable = true
  if (internalizableRaw !== undefined) {
    if (internalizableRaw !== 'true' && internalizableRaw !== 'false') {
      fail('front matter "internalizable" must be true or false')
    } else {
      internalizable = internalizableRaw === 'true'
    }
  }

  attributes.title = readText('title') ?? edge.id
  attributes.authority = readEnum('authority', AUTHORITIES, 'advisory')
  attributes.internalizable = internalizable
  attributes.origin = readEnum('origin', ORIGINS, 'human')
  attributes.reviewStatus = readEnum('reviewStatus', REVIEW_STATUSES, 'draft')
  attributes.tags = readArray('tags') ?? []
  attributes.sourceRefs = readArray('sourceRefs') ?? []
  if (documentId !== undefined) attributes.documentId = documentId
  if (relationType !== undefined) attributes.relationType = relationType

  return { attributes, body: split.body, issues }
}

/** Read one edge and its optional relation document. */
async function loadGraphJsonEdge(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
  manifestEdge: GraphManifestEdge,
): Promise<{ edge: LoadedGraphEdge; issues: GraphValidationIssue[] }> {
  const issues: GraphValidationIssue[] = []
  const fallback: LoadedGraphEdge = {
    id: manifestEdge.id,
    type: manifestEdge.type,
    from: manifestEdge.from,
    to: manifestEdge.to,
    title: manifestEdge.id,
    authority: 'advisory',
    internalizable: true,
    origin: 'human',
    reviewStatus: 'draft',
    tags: [],
    sourceRefs: [],
    missing: false,
  }
  const explicit = manifestEdge.doc !== undefined
  const candidate = manifestEdge.doc ?? edgeDocPath(store.graphId, manifestEdge.id)
  if (!isSafeRelPath(candidate)) {
    issues.push(errorIssue(
      'path-escape',
      `edge "${manifestEdge.id}" document path "${candidate}" is not a safe scope-relative path`,
      candidate,
    ))
    return { edge: { ...fallback, missing: true }, issues }
  }
  const info = await statFile(host, joinRel(store.actualBase, candidate))
  if (info === undefined || info.kind !== 'file') {
    if (explicit) {
      issues.push(warningIssue(
        'missing-edge-doc',
        `edge "${manifestEdge.id}" document "${candidate}" does not exist`,
        candidate,
      ))
      return { edge: { ...fallback, docPath: candidate, missing: true }, issues }
    }
    // A topology-only edge is valid; there is no document to report.
    return { edge: fallback, issues }
  }
  if ((info.size ?? 0) > GRAPH_JSON_TEXT_LIMIT) {
    issues.push(warningIssue(
      'missing-edge-doc',
      `edge "${manifestEdge.id}" document "${candidate}" is larger than the readable window; defaults are used`,
      candidate,
    ))
    return { edge: { ...fallback, docPath: candidate, missing: true }, issues }
  }
  let source: string
  try {
    source = await readScopeText(host, store, candidate)
  } catch (error) {
    issues.push(warningIssue(
      'missing-edge-doc',
      `edge "${manifestEdge.id}" document "${candidate}" could not be read (${messageOf(error)})`,
      candidate,
    ))
    return { edge: { ...fallback, docPath: candidate, missing: true }, issues }
  }
  const parsed = parseEdgeDocument(source, manifestEdge, candidate)
  issues.push(...parsed.issues)
  return {
    edge: {
      ...fallback,
      title: parsed.attributes.title,
      authority: parsed.attributes.authority,
      internalizable: parsed.attributes.internalizable,
      origin: parsed.attributes.origin,
      reviewStatus: parsed.attributes.reviewStatus,
      tags: parsed.attributes.tags,
      sourceRefs: parsed.attributes.sourceRefs,
      docPath: candidate,
      missing: false,
    },
    issues,
  }
}

/** Validate one parsed `graph.json` object and return it with typed nodes/edges. */
function parseManifestRecord(text: string, graphId: string): { record: Record<string, unknown>; manifest: GraphManifest } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new KnowledgeToolError('invalid', 'graph.json is not valid JSON: ' + messageOf(error), graphId)
  }
  if (!isRecord(parsed)) throw new KnowledgeToolError('invalid', 'graph.json must contain a JSON object', graphId)
  if (parsed.schemaVersion !== 1) throw new KnowledgeToolError('invalid', 'graph.json "schemaVersion" must be 1', graphId)
  if (typeof parsed.id !== 'string' || parsed.id !== graphId) {
    throw new KnowledgeToolError(
      'invalid',
      `graph.json id ${JSON.stringify(parsed.id)} does not match its .graphs directory "${graphId}"`,
      graphId,
    )
  }
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new KnowledgeToolError('invalid', 'graph.json "nodes" and "edges" must be arrays', graphId)
  }
  parsed.nodes.forEach((item, index) => {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.trim() === '' || typeof item.path !== 'string' || item.path.trim() === '') {
      throw new KnowledgeToolError('invalid', `graph.json "nodes[${index}]" must have a non-empty "id" and "path"`, graphId)
    }
  })
  parsed.edges.forEach((item, index) => {
    if (
      !isRecord(item)
      || typeof item.id !== 'string' || item.id.trim() === ''
      || typeof item.from !== 'string' || item.from.trim() === ''
      || typeof item.to !== 'string' || item.to.trim() === ''
      || typeof item.type !== 'string' || item.type.trim() === ''
    ) {
      throw new KnowledgeToolError('invalid', `graph.json "edges[${index}]" must have non-empty "id", "from", "to" and "type"`, graphId)
    }
    if (item.doc !== undefined && typeof item.doc !== 'string') {
      throw new KnowledgeToolError('invalid', `graph.json "edges[${index}].doc" must be a string`, graphId)
    }
  })
  return { record: parsed, manifest: parsed as unknown as GraphManifest }
}

/** Load one `.graphs/<id>` graph: manifest, every referenced document, and issues. */
async function loadGraphJsonState(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
): Promise<GraphJsonState> {
  const manifestInfo = await statFile(host, joinRel(store.actualStorePath, 'graph.json'))
  if (manifestInfo === undefined || manifestInfo.kind !== 'file') {
    throw new KnowledgeToolError('not-found', 'the graph has no graph.json', store.graph.path)
  }
  if ((manifestInfo.size ?? 0) > GRAPH_JSON_TEXT_LIMIT) {
    throw new KnowledgeToolError(
      'too-large',
      `graph.json is larger than the ${String(GRAPH_JSON_TEXT_LIMIT)}-byte readable window`,
      store.graph.path,
    )
  }
  const manifestText = await readStoreText(host, store, 'graph.json')
  const { record, manifest } = parseManifestRecord(manifestText, store.graphId)

  const nodes: LoadedGraphNode[] = []
  const edges: LoadedGraphEdge[] = []
  const issues: GraphValidationIssue[] = []
  for (const manifestNode of manifest.nodes) {
    const loaded = await loadGraphJsonNode(host, store, manifestNode)
    nodes.push(loaded.node)
    issues.push(...loaded.issues)
  }
  for (const manifestEdge of manifest.edges) {
    const loaded = await loadGraphJsonEdge(host, store, manifestEdge)
    edges.push(loaded.edge)
    issues.push(...loaded.issues)
  }
  return { store, raw: record, manifest, nodes, edges, issues, manifestText }
}

/** The `LoadedGraph` shape `validateGraph` recomputes from (it ignores `root`). */
function loadedGraphOf(state: GraphJsonState): LoadedGraph {
  return {
    manifest: state.manifest,
    root: state.store.actualBase,
    nodes: state.nodes,
    edges: state.edges,
    issues: state.issues,
  }
}

/** Reload the graph and return the validator's error-level issues. */
async function validateGraphStore(host: KnowledgeGraphToolHost, store: GraphJsonStore): Promise<GraphValidationIssue[]> {
  let state: GraphJsonState
  try {
    state = await loadGraphJsonState(host, store)
  } catch (error) {
    throw new KnowledgeToolError('invalid', 'the graph could not be reloaded after the write: ' + messageOf(error), store.graph.path)
  }
  return validateGraph(loadedGraphOf(state))
}

/** Wrap a validator result as the refusal a rolled-back write reports. */
function requireValidGraph(issues: readonly GraphValidationIssue[], store: GraphJsonStore): void {
  if (issues.length === 0) return
  throw new KnowledgeToolError(
    'invalid',
    'the write was rolled back because the graph validator reported: '
      + issues.map(issue => issue.message).join('; '),
    store.graph.path,
  )
}

/**
 * Replace `graph.json` through a temp file and a rename.
 *
 * The old manifest is kept under `_trash/manifests/`: a rename cannot overwrite
 * on every platform without a backup, and keeping it makes the rollback path
 * (restore on a validator error) exact instead of a re-serialisation.
 */
async function commitManifest(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
  caller: { userId: string; label?: string },
  record: Record<string, unknown>,
  previousText: string,
): Promise<ManifestCommit> {
  const content = JSON.stringify(record, null, 2) + '\n'
  const current = joinRel(store.actualStorePath, 'graph.json')
  const tag = stamp()
  const temporary = joinRel(store.actualStorePath, '.tmp/graph.json.' + tag)
  const backup = joinRel(store.actualStorePath, '_trash/manifests/graph.json.' + tag)
  await host.createEntry(temporary, { directory: false, content })
  await host.moveEntry(current, backup, caller)
  try {
    await host.moveEntry(temporary, current, caller)
  } catch (error) {
    await host.moveEntry(backup, current, caller).catch(() => undefined)
    throw error
  }
  return { previousText, backupPath: backup }
}

/** Undo {@link commitManifest}, leaving the replaced bytes under `_trash/manifests/`. */
async function rollbackManifest(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
  caller: { userId: string; label?: string },
  commit: ManifestCommit,
): Promise<void> {
  const current = joinRel(store.actualStorePath, 'graph.json')
  const aside = joinRel(store.actualStorePath, '_trash/manifests/graph.json.rollback-' + stamp())
  try {
    await host.moveEntry(current, aside, caller)
  } catch {
    // The failed commit may have left no graph.json; the backup is still the truth.
  }
  try {
    await host.moveEntry(commit.backupPath, current, caller)
    return
  } catch {
    // Fall through to a byte-for-byte restore of the text the tool read.
  }
  try {
    await host.overwriteFile(current, commit.previousText)
  } catch {
    await host.createEntry(current, { directory: false, content: commit.previousText })
  }
}

/** Move one authoritative document into the graph store's `_trash/<bucket>/`. */
async function moveToTrash(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
  caller: { userId: string; label?: string },
  actualFrom: string,
  bucket: string,
  name: string,
): Promise<{ from: string; to: string }> {
  const safeName = name.replace(/[/\\]/gu, '-').trim() || 'entry'
  const to = joinRel(store.actualStorePath, `_trash/${bucket}/${safeName}`)
  await host.moveEntry(actualFrom, to, caller)
  return { from: actualFrom, to }
}

/** Undo a list of trash moves, newest first. */
async function restoreTrashMoves(
  host: KnowledgeGraphToolHost,
  caller: { userId: string; label?: string },
  moves: readonly { from: string; to: string }[],
): Promise<void> {
  for (const move of [...moves].reverse()) {
    await host.moveEntry(move.to, move.from, caller).catch(() => undefined)
  }
}

/** Require write access to the graph store and (when given) the document it touches. */
async function requireGraphJsonWrite(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
  extraPath?: string,
): Promise<{ userId: string; label?: string }> {
  if (!await host.canWrite(store.actualStorePath)) {
    throw new KnowledgeToolError('forbidden', 'write access is required for this graph', store.graph.path)
  }
  if (extraPath !== undefined && extraPath !== store.actualStorePath && !await host.canWrite(extraPath)) {
    throw new KnowledgeToolError('forbidden', 'write access is required for this document', extraPath)
  }
  return host.resolveCaller()
}

/** The next manifest object: nodes/edges replaced, version bumped, timestamp refreshed. */
function nextManifestRecord(
  state: GraphJsonState,
  nodes: readonly GraphManifestNode[],
  edges: readonly GraphManifestEdge[],
): Record<string, unknown> {
  const version = typeof state.raw.version === 'number' && Number.isFinite(state.raw.version)
    ? state.raw.version + 1
    : 1
  return {
    ...state.raw,
    version,
    updatedAt: new Date().toISOString(),
    nodes: nodes.map(node => ({ id: node.id, path: node.path })),
    edges: edges.map(edge => (
      edge.doc === undefined
        ? { id: edge.id, from: edge.from, to: edge.to, type: edge.type }
        : { id: edge.id, from: edge.from, to: edge.to, type: edge.type, doc: edge.doc }
    )),
  }
}

function stringListArg(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new KnowledgeToolError('invalid', field + ' must be an array of strings')
  }
  return (value as string[]).map(item => item.trim()).filter(item => item !== '')
}

function booleanArg(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new KnowledgeToolError('invalid', field + ' must be true or false')
  return value
}

function enumArg<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined) return undefined
  const text = typeof value === 'string' ? value.trim() : ''
  if (!(allowed as readonly string[]).includes(text)) {
    throw new KnowledgeToolError('invalid', field + ' must be one of ' + allowed.join(', '))
  }
  return text as T
}

/** Which node/edge a graph-json `kg_get`/`kg_set`/`kg_del` call names. */
function resolveGraphJsonTarget(
  state: GraphJsonState,
  id: string,
  kind: string | undefined,
): { node?: LoadedGraphNode; edge?: LoadedGraphEdge } {
  const node = state.nodes.find(item => item.id === id)
  const edge = state.edges.find(item => item.id === id)
  if (kind === 'node') {
    if (node === undefined) throw new KnowledgeToolError('not-found', 'no node has this id', id)
    return { node }
  }
  if (kind === 'edge') {
    if (edge === undefined) throw new KnowledgeToolError('not-found', 'no edge has this id', id)
    return { edge }
  }
  if (kind !== undefined && kind !== '') {
    throw new KnowledgeToolError('invalid', 'kind must be node or edge', id)
  }
  if (node !== undefined && edge !== undefined) {
    throw new KnowledgeToolError('invalid', 'a node and an edge share this id; pass kind to disambiguate', id)
  }
  if (node !== undefined) return { node }
  if (edge !== undefined) return { edge }
  throw new KnowledgeToolError('not-found', 'no node or edge has this id', id)
}

/** Whether any node or edge already uses an id. */
function graphJsonIdTaken(state: GraphJsonState, id: string): boolean {
  return state.nodes.some(node => node.id === id) || state.edges.some(edge => edge.id === id)
}

/** The view-relative path of a node body. */
function nodeViewPath(store: GraphJsonStore, node: { path: string }): string {
  return joinRel(store.viewBase, node.path)
}

/** One node as `kg_get` lists it. */
function nodeSummary(store: GraphJsonStore, node: LoadedGraphNode): Record<string, unknown> {
  return {
    id: node.id,
    title: node.title,
    type: node.type,
    authority: node.authority,
    internalizable: node.internalizable,
    origin: node.origin,
    reviewStatus: node.reviewStatus,
    tags: node.tags,
    sourceRefs: node.sourceRefs,
    path: nodeViewPath(store, node),
    manifestPath: node.path,
    missing: node.missing,
  }
}

/** One edge as `kg_get` lists it. */
function edgeSummary(store: GraphJsonStore, edge: LoadedGraphEdge): Record<string, unknown> {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    type: edge.type,
    title: edge.title,
    authority: edge.authority,
    internalizable: edge.internalizable,
    origin: edge.origin,
    reviewStatus: edge.reviewStatus,
    tags: edge.tags,
    sourceRefs: edge.sourceRefs,
    doc: edge.docPath,
    path: edge.docPath === undefined ? undefined : joinRel(store.viewBase, edge.docPath),
    missing: edge.missing,
  }
}

// ---------------------------------------------------------------------------
// Synthesized overview graphs (`总图`, one per scope)
// ---------------------------------------------------------------------------

/**
 * Reserved `.graphs/<id>` directory of every computed overview.
 *
 * The overview is a **materialized read model**, never a stored graph: there is no
 * `graph.json` under this directory, only the cross-graph link store. A stored
 * manifest would turn the overview into an ordinary graph and let a recursive
 * aggregation include itself.
 */
export const OVERVIEW_GRAPH_ID = '__overview__'

/** Personal overview path, kept as the default spelling every caller knows. */
export const OVERVIEW_GRAPH_PATH = 'personal/.graphs/' + OVERVIEW_GRAPH_ID

/** Display name shared by the three scope-level overviews. */
export const OVERVIEW_GRAPH_NAME = '总图'

/** Cross-graph link store inside the reserved directory. */
export const OVERVIEW_LINKS_FILE = 'links.json'

/** Schema version of `links.json`. */
export const OVERVIEW_LINKS_SCHEMA_VERSION = 1

/** The three knowledge scopes, each with its own overview. */
export const OVERVIEW_LEVELS = ['global', 'department', 'personal'] as const
export type OverviewLevel = (typeof OVERVIEW_LEVELS)[number]

/** One scope the Host resolved for the caller, without credentials. */
export interface OverviewScopeInput {
  level: OverviewLevel
  /** View-relative scope base, e.g. `global`, `department/D1`, `personal`. */
  viewBase: string
  /** Authoritative scope base, e.g. `department/D1`, `personal/<uid>`. */
  actualBase: string
  /** Department display label; empty for global and personal. */
  groupLabel?: string
}

/** The caller facts the inheritance model needs (no credentials). */
export interface OverviewGraphCaller {
  userId: string
  label?: string
  /** Department chain, root first, exactly as the Host resolved it. */
  departmentPathCodes?: string[]
  departmentPathNames?: string[]
}

/** One fully derived overview scope: paths and display grouping. */
export interface OverviewStoreScope {
  level: OverviewLevel
  viewBase: string
  actualBase: string
  groupLabel: string
  /** `<viewBase>/.graphs/__overview__` — the virtual graph's view path. */
  viewPath: string
  /** `<actualBase>/.graphs/__overview__` — holds only `links.json`. */
  actualPath: string
}

/** One persisted cross-graph link. */
export interface OverviewCrossLink {
  id: string
  /** Readable graph the `from` node belongs to (a graph id or path). */
  fromGraph: string
  /** Node id inside {@link fromGraph}. */
  from: string
  /** Readable graph the `to` node belongs to (a graph id or path). */
  toGraph: string
  /** Node id inside {@link toGraph}. */
  to: string
  type: string
  title?: string
  authority: MemoryAuthority
  internalizable: boolean
  origin: MemoryOrigin
  reviewStatus: MemoryReviewStatus
  tags: string[]
  sourceRefs: string[]
  body?: string
  createdAt: string
  updatedAt: string
}

/** The parsed `links.json`. */
interface OverviewLinkStore {
  schemaVersion: typeof OVERVIEW_LINKS_SCHEMA_VERSION
  links: OverviewCrossLink[]
}

/** One source graph in the overview answer. */
export interface OverviewGraphSummary {
  id: string
  name: string
  scope: OverviewLevel
  group: string
  path: string
  format: string
  counts: { topics: number; links: number; documents: number }
  /** True when this graph came from a higher scope and is a read-only contribution. */
  contributed?: boolean
  /** True for a contributed graph; the personal overview never edits an upper source. */
  readOnly?: boolean
}

/** One aggregated node, namespaced as `<graphId>:<nodeId>`. */
export interface OverviewNode {
  /** Namespaced id `<graphId>:<nodeId>`; unique across the overview. */
  id: string
  graphId: string
  graphName: string
  scope: OverviewLevel
  nodeId: string
  type: string
  title: string
  authority?: MemoryAuthority
  reviewStatus?: MemoryReviewStatus
  tags: string[]
  /** View-relative document path, for opening the source node. */
  docPath: string
  /** True when this node came from a higher scope and is a read-only contribution. */
  contributed?: boolean
  /** True for a contributed node; its source graph stays the only editable copy. */
  readOnly?: boolean
}

/** One aggregated edge, with both endpoints remapped to namespaced node ids. */
export interface OverviewEdge {
  /** Edge id: namespaced for a stored graph, the record id for a cross-graph link. */
  id: string
  graphId: string
  edgeId: string
  from: string
  to: string
  type: string
  title?: string
  authority?: MemoryAuthority
  origin?: MemoryOrigin
  reviewStatus?: MemoryReviewStatus
  tags: string[]
  sourceRefs: string[]
  /** True for a link stored in `<scope>/.graphs/__overview__/links.json`. */
  crossGraph: boolean
  /** True when either endpoint graph is a higher-scope contribution. */
  contributed?: boolean
  /** True when this edge belongs to a contributed graph. */
  readOnly?: boolean
}

/** The aggregate `kg_get` answers for one overview and the canvas consumes. */
export interface OverviewAggregate {
  graph: {
    id: string
    name: string
    scope: OverviewLevel
    group: string
    path: string
    format: 'overview'
    computed: true
    readOnly: true
    counts: { topics: number; links: number; documents: number }
  }
  graphs: OverviewGraphSummary[]
  nodes: OverviewNode[]
  edges: OverviewEdge[]
  /** Canvas projection of {@link nodes}; ids are already namespaced. */
  topics: KnowledgeGraphTopic[]
  /** Canvas projection of {@link edges}; endpoints are already namespaced. */
  links: KnowledgeGraphLink[]
  totals: { graphs: number; nodes: number; edges: number; crossEdges: number }
  /** Non-fatal problems (dangling or no-longer-readable cross links). */
  issues: string[]
}

// ---------------------------------------------------------------------------
// OverviewStore: the persistence seam a future Relate backend replaces
// ---------------------------------------------------------------------------

/**
 * The storage contract of one overview scope.
 *
 * MVP is backed by `links.json` (`JsonOverviewStore`). The interface deliberately
 * carries nothing JSON-specific: a memory-first Relate backend implements the
 * same five lifecycle methods (`open` / `query` / `close` / `lastUsed` /
 * `revision`) plus the two write helpers and `estimatedBytes` used by eviction.
 *
 * `query()` never reloads the backing bytes; `open()` is the only load point, so
 * the manager can cache a store across calls. `revision()` changes whenever this
 * store observed a new snapshot, which is what invalidates the aggregate cache.
 */
export interface OverviewStore {
  readonly scope: OverviewStoreScope
  /** Load the backing state once; idempotent. */
  open(): Promise<void>
  /** The current cross-link snapshot. Does not re-read persistent bytes. */
  query(): Promise<OverviewCrossLink[]>
  /** Replace the persisted cross-link snapshot. */
  replace(links: readonly OverviewCrossLink[]): Promise<void>
  /** Drop in-memory state; persistent bytes stay. */
  close(): void
  /** Epoch milliseconds of the last open/query/replace. */
  lastUsed(): number
  /** Opaque token that changes when the store observed new content. */
  revision(): string
  /** Rough in-memory footprint, for the manager's memory budget. */
  estimatedBytes(): number
  /** Non-fatal parse issues from the last open. */
  issues(): readonly string[]
}

/** How the manager opens a store for one scope. */
export interface OverviewStoreProvider {
  open(scope: OverviewStoreScope): Promise<OverviewStore>
}

/** Build a `links.json` store for one Host and scope. */
export class JsonOverviewStore implements OverviewStore {
  readonly scope: OverviewStoreScope
  private links: OverviewCrossLink[] | undefined
  private storeIssues: string[] = []
  private used: number
  private rev = 0
  /** The file this store last read, so a standalone flat layout writes back to it. */
  private pathUsed: string

  constructor(
    private readonly host: KnowledgeGraphToolHost,
    scope: OverviewStoreScope,
    private readonly now: () => number = Date.now,
    /** Materialized read-model root; a getter lets the startup probe swap it. */
    private readonly storeDir?: string | (() => string | undefined),
  ) {
    this.scope = scope
    this.used = now()
    this.pathUsed = scope.actualPath + '/' + OVERVIEW_LINKS_FILE
  }

  async open(): Promise<void> {
    if (this.links !== undefined) return
    const state = await loadOverviewLinks(this.host, this.scope)
    this.links = state.links
    this.storeIssues = state.issues
    this.pathUsed = state.actualPath
    this.used = this.now()
    this.rev += 1
  }

  async query(): Promise<OverviewCrossLink[]> {
    await this.open()
    this.used = this.now()
    return [...(this.links ?? [])]
  }

  async replace(links: readonly OverviewCrossLink[]): Promise<void> {
    await writeOverviewLinks(this.host, this.pathUsed, renderOverviewLinks(links))
    this.links = [...links]
    this.storeIssues = []
    this.used = this.now()
    this.rev += 1
  }

  close(): void {
    this.links = undefined
  }

  lastUsed(): number {
    return this.used
  }

  revision(): string {
    return String(this.rev) + ':' + (this.links === undefined ? 'closed' : JSON.stringify(this.links))
  }

  estimatedBytes(): number {
    return this.links === undefined ? 0 : JSON.stringify(this.links).length * 2
  }

  issues(): readonly string[] {
    return this.storeIssues
  }

  /**
   * Persist the derived read model under the probed store root.
   *
   * This snapshot is not the source of truth — `links.json` is — so a failed
   * write never blocks a read and a missing store root simply skips it. It gives
   * the future Relate adapter a concrete, probe-tested location to replace.
   */
  async materialize(aggregate: OverviewAggregate): Promise<void> {
    const root = typeof this.storeDir === 'function' ? this.storeDir() : this.storeDir
    if (root === undefined || root === '') return
    const directory = join(root, this.scope.level)
    await mkdir(directory, { recursive: true })
    const name = this.scope.actualPath.replace(/[^A-Za-z0-9._-]+/gu, '_') + '.json'
    const handle = await open(join(directory, name), 'w')
    try {
      await handle.writeFile(JSON.stringify({
        schemaVersion: 1,
        revision: this.revision(),
        scope: this.scope,
        aggregate,
      }, null, 2))
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

/** The default MVP provider: one `links.json` per scope plus a JSON read-model snapshot. */
export class JsonOverviewStoreProvider implements OverviewStoreProvider {
  constructor(
    private readonly host: KnowledgeGraphToolHost,
    /** Resolved store root; read lazily so the startup probe can swap it. */
    private readonly storeDir?: () => string | undefined,
  ) {}

  async open(scope: OverviewStoreScope): Promise<OverviewStore> {
    const store = new JsonOverviewStore(this.host, scope, Date.now, this.storeDir?.())
    await store.open()
    return store
  }
}

/** Where the store goes when the KB root cannot satisfy the probe. */
export const OVERVIEW_STORE_FALLBACK_DIR = '/var/lib/dataops/kb-overview'

/** One probe check per capability the backend must provide. */
export interface OverviewStoreProbeChecks {
  open: boolean
  write: boolean
  fsync: boolean
  read: boolean
  lock: boolean
}

/** Outcome of the startup compatibility probe. */
export interface OverviewStoreProbeResult {
  /** Directory the store should actually use. */
  dir: string
  /** Directory the configuration asked for. */
  requested: string
  /** True when {@link dir} is the local fallback rather than the requested root. */
  fallback: boolean
  /** True only when every capability passed in the directory actually used. */
  ok: boolean
  checks: OverviewStoreProbeChecks
  error?: string
}

/** Probe one directory: open/write/fsync/read/lock, cleaning up after itself. */
async function probeOverviewStoreOnce(dir: string): Promise<{
  ok: boolean
  checks: OverviewStoreProbeChecks
  error?: string
}> {
  const checks: OverviewStoreProbeChecks = {
    open: false,
    write: false,
    fsync: false,
    read: false,
    lock: false,
  }
  const probeFile = join(dir, '.probe-' + String(process.pid) + '-' + String(Date.now()))
  const lockFile = join(dir, '.probe-lock-' + String(process.pid) + '-' + String(Date.now()))
  try {
    await mkdir(dir, { recursive: true })
    checks.open = true
    const handle = await open(probeFile, 'w')
    try {
      await handle.writeFile('kb-overview-probe\n')
      checks.write = true
      await handle.sync()
      checks.fsync = true
    } finally {
      await handle.close()
    }
    checks.read = await readFile(probeFile, 'utf8') === 'kb-overview-probe\n'
    const lock = await open(lockFile, 'wx')
    checks.lock = true
    await lock.close()
    return { ok: Object.values(checks).every(Boolean), checks }
  } catch (error) {
    return { ok: false, checks, error: messageOf(error) }
  } finally {
    await unlink(probeFile).catch(() => undefined)
    await unlink(lockFile).catch(() => undefined)
  }
}

/**
 * Probe the configured overview store root and fall back when it is unusable.
 *
 * A KB root may be a read-only NAS, an unmounted share, or a filesystem without
 * the lock/fsync semantics a store needs. The probe never assumes availability:
 * it creates a file, fsyncs it, reads it back and takes an exclusive lock, then
 * removes both artifacts. A failed requested root moves the store to
 * {@link OVERVIEW_STORE_FALLBACK_DIR}; reads keep working either way.
 */
export async function probeOverviewStoreDir(
  requested: string,
  fallbackDir: string = OVERVIEW_STORE_FALLBACK_DIR,
): Promise<OverviewStoreProbeResult> {
  const primary = await probeOverviewStoreOnce(requested)
  const result: OverviewStoreProbeResult = primary.ok
    ? { dir: requested, requested, fallback: false, ok: true, checks: primary.checks }
    : await (async (): Promise<OverviewStoreProbeResult> => {
        const fallback = await probeOverviewStoreOnce(fallbackDir)
        return {
          dir: fallbackDir,
          requested,
          fallback: true,
          ok: fallback.ok,
          checks: fallback.checks,
          ...(primary.error === undefined && fallback.error === undefined
            ? {}
            : { error: [primary.error, fallback.error].filter((item): item is string => item !== undefined).join('; ') }),
        }
      })()
  // Durable metric and store manifest beside the snapshots. The Host log carries
  // the same values; this file survives a log rotation and lets an operator see
  // which root won, which backend is active and which probe checks passed.
  await writeFile(join(result.dir, 'manifest.json'), JSON.stringify({
    backend: 'json',
    schemaVersion: 1,
    metric: 'kb.overview.store.probe',
    at: new Date().toISOString(),
    ...result,
  }, null, 2) + '\n').catch(() => undefined)
  return result
}

/** TTL floors/ceilings in minutes, per the approved memory lifecycle. */
const OVERVIEW_TTL_MINUTES: Record<OverviewLevel, { min: number; max: number; fallback: number }> = {
  personal: { min: 5, max: 10, fallback: 10 },
  department: { min: 15, max: 30, fallback: 20 },
  global: { min: 30, max: 60, fallback: 45 },
}

/** Manager knobs; every value is overridable and the defaults stay inside the policy. */
export interface OverviewStoreManagerOptions {
  /** Idle TTL per level, clamped to 5–10 / 15–30 / 30–60 minutes. */
  ttlMs?: Partial<Record<OverviewLevel, number>>
  /** Hard cap on cached stores; idle LRU entries are evicted first. */
  maxStores?: number
  /** Soft memory budget for cached link snapshots; idle LRU entries are evicted first. */
  memoryBudgetBytes?: number
  /** Injectable clock, so lifecycle tests do not sleep. */
  now?: () => number
}

/** One cached store plus its reference count and recency. */
interface OverviewStoreEntry {
  store: OverviewStore
  refs: number
  lastUsed: number
}

/**
 * Lifecycle owner for every overview store.
 *
 * The approved model is per scope: global and department stores are shared by
 * everyone allowed to read that scope, while a personal store belongs to exactly
 * one user. Stores load on first use, stay open while an operation holds a
 * reference, and are evicted by idle TTL, LRU count and the memory budget.
 *
 * `rebuild()` opens the replacement completely before swapping it into the map
 * and closing the old one, so a reader never observes a half-built store. A future
 * auth/logout hook calls {@link closePersonal}; plugin disposal calls
 * {@link closeAll}.
 */
export class OverviewStoreManager {
  private readonly entries = new Map<string, OverviewStoreEntry>()
  private readonly ttlMs: Record<OverviewLevel, number>
  private readonly maxStores: number
  private readonly memoryBudgetBytes: number
  private readonly now: () => number

  constructor(private readonly provider: OverviewStoreProvider, options: OverviewStoreManagerOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = {
      personal: clampTtl('personal', options.ttlMs?.personal),
      department: clampTtl('department', options.ttlMs?.department),
      global: clampTtl('global', options.ttlMs?.global),
    }
    this.maxStores = Math.max(1, options.maxStores ?? 64)
    this.memoryBudgetBytes = Math.max(0, options.memoryBudgetBytes ?? 32 * 1024 * 1024)
  }

  /** Key a store by level + authoritative base; personal therefore includes the uid. */
  private keyOf(scope: OverviewStoreScope): string {
    return scope.level + ':' + scope.actualPath
  }

  /** Open (or reuse) one store and take a reference. */
  async acquire(scope: OverviewStoreScope): Promise<OverviewStore> {
    const key = this.keyOf(scope)
    let entry = this.entries.get(key)
    if (entry === undefined) {
      const store = await this.provider.open(scope)
      entry = { store, refs: 0, lastUsed: store.lastUsed() }
      this.entries.set(key, entry)
    }
    entry.refs += 1
    entry.lastUsed = this.now()
    this.sweep()
    return entry.store
  }

  /** Drop one reference; eviction happens on the next sweep. */
  release(store: OverviewStore): void {
    const entry = this.entries.get(this.keyOf(store.scope))
    if (entry === undefined || entry.store !== store) return
    entry.refs = Math.max(0, entry.refs - 1)
    entry.lastUsed = this.now()
  }

  /**
   * Close every personal store that belongs to one user.
   *
   * The future managed-auth logout/revocation hook calls this; the JSON MVP also
   * relies on it when a caller disappears, so a shared process never keeps another
   * user's personal snapshot alive.
   */
  closePersonal(userId: string): void {
    const marker = 'personal/' + userId + '/.graphs/' + OVERVIEW_GRAPH_ID
    for (const [key, entry] of this.entries) {
      if (entry.store.scope.level !== 'personal') continue
      if (entry.store.scope.actualPath !== marker
        && !entry.store.scope.actualPath.endsWith('/' + marker)) continue
      entry.store.close()
      this.entries.delete(key)
    }
  }

  /** Plugin disposal / process exit: close every store once. */
  closeAll(): void {
    for (const entry of this.entries.values()) entry.store.close()
    this.entries.clear()
  }

  /**
   * Replace one scope's store atomically.
   *
   * The new store is opened in full first; only then does the map switch to it and
   * the old store close. A failed open leaves readers on the old snapshot.
   */
  async rebuild(scope: OverviewStoreScope): Promise<OverviewStore> {
    const key = this.keyOf(scope)
    const fresh = await this.provider.open(scope)
    await fresh.open()
    const previous = this.entries.get(key)
    this.entries.set(key, {
      store: fresh,
      refs: previous?.refs ?? 0,
      lastUsed: this.now(),
    })
    previous?.store.close()
    return fresh
  }

  /** Evict idle stores by TTL, then by LRU count, then by memory budget. */
  sweep(at: number = this.now()): void {
    for (const [key, entry] of [...this.entries]) {
      if (entry.refs > 0) continue
      if (at - entry.lastUsed <= this.ttlMs[entry.store.scope.level]) continue
      entry.store.close()
      this.entries.delete(key)
    }
    this.evictToCount(this.maxStores)
    while (this.cachedBytes() > this.memoryBudgetBytes) {
      if (!this.evictOneIdleLru()) break
    }
  }

  /** Cached store count, for diagnostics and tests. */
  size(): number {
    return this.entries.size
  }

  /** Cached footprint, for diagnostics and tests. */
  cachedBytes(): number {
    let total = 0
    for (const entry of this.entries.values()) total += entry.store.estimatedBytes()
    return total
  }

  private evictToCount(limit: number): void {
    while (this.entries.size > limit && this.evictOneIdleLru()) {
      // `evictOneIdleLru` is the loop body; a non-idle-only map stops here.
    }
  }

  private evictOneIdleLru(): boolean {
    let victimKey: string | undefined
    let victimAt = Number.POSITIVE_INFINITY
    for (const [key, entry] of this.entries) {
      if (entry.refs > 0) continue
      if (entry.lastUsed < victimAt) {
        victimAt = entry.lastUsed
        victimKey = key
      }
    }
    if (victimKey === undefined) return false
    const victim = this.entries.get(victimKey)
    victim?.store.close()
    this.entries.delete(victimKey)
    return true
  }
}

/** Clamp a configured TTL to its level's approved range. */
function clampTtl(level: OverviewLevel, value: number | undefined): number {
  const range = OVERVIEW_TTL_MINUTES[level]
  const fallback = range.fallback * 60_000
  if (value === undefined || !Number.isFinite(value)) return fallback
  const min = range.min * 60_000
  const max = range.max * 60_000
  return Math.min(max, Math.max(min, value))
}

/** Cache slot: one aggregate per host and overview scope. */
const overviewCache = new WeakMap<KnowledgeGraphToolHost, Map<string, { key: string; value: OverviewAggregate }>>()

/** Whether a graph row is one of the computed overviews. */
export function isOverviewGraph(
  graph: Pick<KnowledgeGraphNode, 'id' | 'path' | 'computed'>,
): boolean {
  if (graph.computed === true) return true
  return isOverviewStorePath(graph.id) || isOverviewStorePath(graph.path)
}

/** Whether a path is `<anything>/.graphs/__overview__`. */
function isOverviewStorePath(value: string): boolean {
  const parts = value.split('/')
  return parts.length >= 3
    && parts[parts.length - 2] === '.graphs'
    && parts[parts.length - 1] === OVERVIEW_GRAPH_ID
}

/** The scope base of a graph root (`<base>/知识图谱` → `<base>`). */
function scopeBaseOfRoot(value: string): string {
  const parts = value.split('/').filter(segment => segment !== '')
  if (parts.length > 0 && parts[parts.length - 1] === KNOWLEDGE_GRAPH_FOLDER) parts.pop()
  return parts.join('/')
}

/** Turn Host-resolved graph roots into overview scopes. */
export function overviewScopesFromRoots(
  roots: ReadonlyArray<{ key: OverviewLevel; actualPath: string; viewPath: string; groupLabel?: string }>,
): OverviewScopeInput[] {
  const scopes: OverviewScopeInput[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    const viewBase = scopeBaseOfRoot(root.viewPath)
    const actualBase = scopeBaseOfRoot(root.actualPath)
    const key = root.key + ':' + actualBase
    if (seen.has(key)) continue
    seen.add(key)
    scopes.push({
      level: root.key,
      viewBase,
      actualBase,
      ...(root.groupLabel === undefined || root.groupLabel === '' ? {} : { groupLabel: root.groupLabel }),
    })
  }
  return scopes
}

/** Derive the store scope of one overview row. */
export function overviewStoreScopeOf(graph: Pick<KnowledgeGraphNode, 'path' | 'actualPath' | 'scope' | 'group'>): OverviewStoreScope {
  const suffix = '/.graphs/' + OVERVIEW_GRAPH_ID
  const viewBase = graph.path.endsWith(suffix) ? graph.path.slice(0, -suffix.length) : scopeBaseOfRoot(graph.path)
  const actualPath = graph.actualPath ?? graph.path
  const actualBase = actualPath.endsWith(suffix) ? actualPath.slice(0, -suffix.length) : scopeBaseOfRoot(actualPath)
  return overviewStoreScope({
    level: graph.scope,
    viewBase,
    actualBase,
    groupLabel: graph.group,
  })
}

/** Complete one scope input into its store coordinates. */
export function overviewStoreScope(input: OverviewScopeInput): OverviewStoreScope {
  return {
    level: input.level,
    viewBase: input.viewBase,
    actualBase: input.actualBase,
    groupLabel: input.groupLabel ?? '',
    viewPath: joinRel(input.viewBase, '.graphs/' + OVERVIEW_GRAPH_ID),
    actualPath: joinRel(input.actualBase, '.graphs/' + OVERVIEW_GRAPH_ID),
  }
}

/** The synthetic graph row one scope's overview publishes. */
export function overviewGraphNode(scope: OverviewStoreScope, aggregate?: OverviewAggregate): KnowledgeGraphNode {
  const counts = aggregate === undefined
    ? { topics: 0, links: 0, documents: 0 }
    : {
        topics: aggregate.nodes.length,
        links: aggregate.edges.length,
        documents: aggregate.nodes.length,
      }
  return {
    id: scope.viewPath,
    name: OVERVIEW_GRAPH_NAME,
    scope: scope.level,
    path: scope.viewPath,
    group: scope.groupLabel,
    topics: aggregate?.topics ?? [],
    links: aggregate?.links ?? [],
    counts,
    actualPath: scope.actualPath,
    computed: true,
    readOnly: true,
  }
}

/** The default scope: the caller's personal overview. */
export async function personalOverviewScope(host: KnowledgeGraphToolHost): Promise<OverviewStoreScope> {
  const caller = await host.resolveCaller()
  if (!isSafeSegment(caller.userId)) {
    throw new KnowledgeToolError('forbidden', 'unsafe caller id; cannot resolve the personal overview')
  }
  return overviewStoreScope({
    level: 'personal',
    viewBase: 'personal',
    actualBase: 'personal/' + caller.userId,
  })
}

/** Read one hidden path, treating any refusal as "not there". */
async function readHiddenText(
  host: KnowledgeGraphToolHost,
  relPath: string,
): Promise<string | undefined> {
  if (host.readActual === undefined) return undefined
  try {
    if (host.statActual !== undefined && await host.statActual(relPath) === undefined) return undefined
    return await host.readActual(relPath)
  } catch {
    return undefined
  }
}

/** Whether a hidden path exists, through the Host's own stat seam. */
async function hiddenExists(host: KnowledgeGraphToolHost, relPath: string): Promise<boolean> {
  if (host.statActual !== undefined) return await host.statActual(relPath) !== undefined
  return await readHiddenText(host, relPath) !== undefined
}

/** Parse and validate one link record; returns undefined for an unusable row. */
function parseOverviewLink(value: unknown): OverviewCrossLink | undefined {
  if (!isRecord(value)) return undefined
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const fromGraph = typeof value.fromGraph === 'string' ? value.fromGraph.trim() : ''
  const from = typeof value.from === 'string' ? value.from.trim() : ''
  const toGraph = typeof value.toGraph === 'string' ? value.toGraph.trim() : ''
  const to = typeof value.to === 'string' ? value.to.trim() : ''
  const type = typeof value.type === 'string' ? value.type.trim() : ''
  if (!GRAPH_ITEM_ID.test(id) || fromGraph === '' || from === '' || toGraph === '' || to === '' || type === '') {
    return undefined
  }
  const authority = value.authority
  const origin = value.origin
  const reviewStatus = value.reviewStatus
  if (!AUTHORITIES.includes(authority as MemoryAuthority)) return undefined
  if (!ORIGINS.includes(origin as MemoryOrigin)) return undefined
  if (!REVIEW_STATUSES.includes(reviewStatus as MemoryReviewStatus)) return undefined
  const tags = Array.isArray(value.tags) && value.tags.every(item => typeof item === 'string')
    ? (value.tags as string[]).map(item => item.trim()).filter(item => item !== '')
    : []
  const sourceRefs = Array.isArray(value.sourceRefs) && value.sourceRefs.every(item => typeof item === 'string')
    ? (value.sourceRefs as string[]).map(item => item.trim()).filter(item => item !== '')
    : []
  const title = typeof value.title === 'string' && value.title.trim() !== '' ? value.title.trim() : undefined
  const body = typeof value.body === 'string' && value.body.trim() !== '' ? value.body : undefined
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : ''
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : ''
  return {
    id,
    fromGraph,
    from,
    toGraph,
    to,
    type,
    ...(title === undefined ? {} : { title }),
    authority: authority as MemoryAuthority,
    internalizable: value.internalizable !== false,
    origin: origin as MemoryOrigin,
    reviewStatus: reviewStatus as MemoryReviewStatus,
    tags,
    sourceRefs,
    ...(body === undefined ? {} : { body }),
    createdAt,
    updatedAt,
  }
}

/** Read the cross-link store of one scope, or an empty one when it does not exist. */
async function loadOverviewLinks(
  host: KnowledgeGraphToolHost,
  scope: OverviewStoreScope,
): Promise<{ links: OverviewCrossLink[]; issues: string[]; actualPath: string }> {
  const primary = scope.actualPath + '/' + OVERVIEW_LINKS_FILE
  const candidates = [primary]
  // A standalone personal tree keeps the flat `personal/...` spelling. Global and
  // department scopes have a single authoritative path and need no fallback.
  if (scope.level === 'personal' && scope.actualBase !== 'personal') {
    candidates.push('personal/.graphs/' + OVERVIEW_GRAPH_ID + '/' + OVERVIEW_LINKS_FILE)
  }
  let source: string | undefined
  let actualPath = primary
  for (const candidate of candidates) {
    source = await readHiddenText(host, candidate)
    if (source !== undefined) {
      actualPath = candidate
      break
    }
  }
  if (source === undefined) return { links: [], issues: [], actualPath }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    return { links: [], issues: ['links.json is not valid JSON: ' + messageOf(error)], actualPath }
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== OVERVIEW_LINKS_SCHEMA_VERSION || !Array.isArray(parsed.links)) {
    return { links: [], issues: ['links.json must be {"schemaVersion":1,"links":[...]}'], actualPath }
  }
  const links: OverviewCrossLink[] = []
  const issues: string[] = []
  const seen = new Set<string>()
  for (const [index, row] of parsed.links.entries()) {
    const link = parseOverviewLink(row)
    if (link === undefined) {
      issues.push('links[' + String(index) + '] is not a valid cross-graph link')
      continue
    }
    if (seen.has(link.id)) {
      issues.push('duplicate cross-graph link id "' + link.id + '" was ignored')
      continue
    }
    seen.add(link.id)
    links.push(link)
  }
  return { links, issues, actualPath }
}

/** Serialize the store, preserving nothing else: `links.json` is fully owned here. */
function renderOverviewLinks(links: readonly OverviewCrossLink[]): string {
  return JSON.stringify({
    schemaVersion: OVERVIEW_LINKS_SCHEMA_VERSION,
    links: [...links],
  }, null, 2) + '\n'
}

/** Write `links.json` through the Host seam. */
async function writeOverviewLinks(
  host: KnowledgeGraphToolHost,
  actualPath: string,
  content: string,
): Promise<void> {
  const directory = actualPath.split('/').slice(0, -1).join('/')
  // Check the directory, not the (possibly not-yet-created) file: a grant covers
  // creating `links.json` inside the scope, and a resolve on a missing file path
  // would refuse a legitimate first write.
  if (!await host.canWrite(directory)) {
    throw new KnowledgeToolError('forbidden', 'write access is required for this overview scope', directory)
  }
  await host.createEntry(directory, { directory: true }).catch(() => undefined)
  if (await hiddenExists(host, actualPath)) {
    await host.overwriteFile(actualPath, content)
    return
  }
  try {
    await host.createEntry(actualPath, { directory: false, content })
  } catch (error) {
    if ((error as { code?: string }).code === 'exists') {
      await host.overwriteFile(actualPath, content)
      return
    }
    throw error
  }
}

/** Find one readable graph by id, path or unique name. */
function findGraphReference(
  graphs: readonly KnowledgeGraphNode[],
  value: string,
): KnowledgeGraphNode | undefined {
  const needle = value.trim()
  const found = graphs.filter(graph => graph.id === needle || graph.path === needle || graph.name === needle)
  return found.length === 1 ? found[0] : undefined
}

/** Resolve the caller with the department chain, falling back to the basic seam. */
async function resolveOverviewCaller(host: KnowledgeGraphToolHost): Promise<OverviewGraphCaller> {
  if (host.resolveGraphCaller !== undefined) return await host.resolveGraphCaller()
  const caller = await host.resolveCaller()
  return {
    userId: caller.userId,
    ...(caller.label === undefined ? {} : { label: caller.label }),
  }
}

/**
 * The department code chain of a department graph, derived from its authoritative
 * path (`department/<D1>/<D2>/.../(.graphs|知识图谱)/...`).
 *
 * The view path is deliberately not used first: a flat legacy view links the graph
 * at `department/知识图谱/...` while its bytes (and therefore its department) live
 * under the actual code chain. An unprovable chain returns undefined and the graph
 * is excluded from a department/personal contribution set rather than guessed in.
 */
export function graphDepartmentCodes(
  graph: Pick<KnowledgeGraphNode, 'scope' | 'path' | 'actualPath'>,
): string[] | undefined {
  if (graph.scope !== 'department') return undefined
  const candidate = graph.actualPath !== undefined && graph.actualPath !== '' ? graph.actualPath : graph.path
  const parts = candidate.split('/').filter(segment => segment !== '')
  if (parts[0] !== 'department') return undefined
  let marker = -1
  for (let index = 1; index < parts.length; index += 1) {
    if (parts[index] === KNOWLEDGE_GRAPH_FOLDER || parts[index] === '.graphs') {
      marker = index
      break
    }
  }
  if (marker < 0) return undefined
  const codes = parts.slice(1, marker)
  return codes.length > 0 ? codes : undefined
}

/** Whether a department chain is the caller's own department or one of its descendants. */
export function departmentInSubtree(
  codes: readonly string[],
  callerCodes: readonly string[],
): boolean {
  if (callerCodes.length === 0 || codes.length < callerCodes.length) return false
  return callerCodes.every((code, index) => codes[index] === code)
}

/**
 * The readable graphs contributing to one overview level.
 *
 * - global: global graphs only.
 * - department: the caller's own department, its subdepartments, plus global.
 * - personal: personal graphs plus the department subtree and global; personal
 *   never pulls another user's personal graph.
 *
 * `graphs` is already permission-filtered by the Host, so an unreadable graph is
 * absent before this function runs. A department graph whose chain cannot be
 * proven is omitted (no name/count disclosure).
 */
export function graphsForLevel(
  caller: OverviewGraphCaller,
  level: OverviewLevel,
  graphs: readonly KnowledgeGraphNode[],
): KnowledgeGraphNode[] {
  const callerCodes = caller.departmentPathCodes ?? []
  return graphs.filter(graph => {
    if (isOverviewGraph(graph)) return false
    if (level === 'global') return graph.scope === 'global'
    if (graph.scope === 'global') return true
    if (graph.scope === 'personal') {
      if (level !== 'personal') return false
      const actual = graph.actualPath
      if (actual === undefined || actual === '') return true
      // Team layout carries the owner; a local tree is flat and the Host has
      // already scoped the catalogue to this single user.
      return actual.startsWith('personal/' + caller.userId + '/')
        || actual.startsWith('personal/.graphs/')
    }
    if (graph.scope === 'department') {
      const codes = graphDepartmentCodes(graph)
      if (codes === undefined || !departmentInSubtree(codes, callerCodes)) return false
      return level === 'department' || level === 'personal'
    }
    return false
  })
}

/** Stable key for the aggregate cache: scope, catalogue content and link snapshot. */
function overviewSignature(
  scope: OverviewStoreScope,
  graphs: readonly KnowledgeGraphNode[],
  links: readonly OverviewCrossLink[],
): string {
  const catalogue = graphs.map(graph => [
    graph.id,
    graph.name,
    graph.scope,
    String(graph.counts.topics),
    String(graph.counts.links),
    graph.topics.map(topic => [
      topic.id,
      topic.title,
      topic.domain ?? '',
      topic.authority ?? '',
      topic.reviewStatus ?? '',
      topic.origin ?? '',
      topic.tags.join('\u0006'),
      topic.documents[0]?.path ?? topic.path,
    ].join('\u0001')).join('\u0002'),
  ].join('\u0003')).join('\u0004')
  return scope.level + '\u0007' + scope.actualBase + '\u0005' + catalogue + '\u0005' + JSON.stringify(links)
}

/** Acquire one store through the manager, or a transient one when none is wired. */
async function acquireOverviewStore(
  host: KnowledgeGraphToolHost,
  scope: OverviewStoreScope,
): Promise<{ store: OverviewStore; transient: boolean }> {
  if (host.overviewStores !== undefined) {
    return { store: await host.overviewStores.acquire(scope), transient: false }
  }
  const store = new JsonOverviewStore(host, scope)
  await store.open()
  return { store, transient: true }
}

/** Release one store and close it when it was transient. */
function releaseOverviewStore(
  host: KnowledgeGraphToolHost,
  acquired: { store: OverviewStore; transient: boolean },
): void {
  if (!acquired.transient) {
    host.overviewStores?.release(acquired.store)
    return
  }
  acquired.store.close()
}

/**
 * Build the overview from already readable graphs and the cross-link store.
 *
 * Pure and permission-agnostic: every graph in `graphs` has already passed
 * `canReadPath` and belongs to `scope.level`; a cross link is included only when
 * BOTH endpoint graphs are present in that list. A hidden graph is therefore
 * neither named nor counted.
 */
export function buildOverviewAggregate(
  scope: OverviewStoreScope,
  graphs: readonly KnowledgeGraphNode[],
  crossLinks: readonly OverviewCrossLink[] = [],
  storeIssues: readonly string[] = [],
): OverviewAggregate {
  const readable = graphs.filter(graph => !isOverviewGraph(graph))
  const issues: string[] = [...storeIssues]
  const summaries: OverviewGraphSummary[] = []
  const nodeIndex = new Map<string, KnowledgeGraphTopic>()
  const nodes: OverviewNode[] = []
  const topics: KnowledgeGraphTopic[] = []
  const edges: OverviewEdge[] = []
  const links: KnowledgeGraphLink[] = []

  for (const graph of readable) {
    const format = (graph as GraphNodeWithFormat).format ?? 'legacy'
    const contributed = graph.scope !== scope.level
    summaries.push({
      id: graph.id,
      name: graph.name,
      scope: scope.level,
      group: graph.group,
      path: graph.path,
      format,
      counts: { ...graph.counts },
      ...(contributed ? { contributed: true, readOnly: true } : {}),
    })
    for (const topic of graph.topics) {
      const namespaced = graph.id + ':' + topic.id
      if (nodeIndex.has(namespaced)) continue
      const type = format === 'graph-json' ? (topic.domain ?? 'topic') : 'topic'
      const docPath = topic.documents[0]?.path ?? topic.path
      const contributed = graph.scope !== scope.level
      nodeIndex.set(namespaced, topic)
      nodes.push({
        id: namespaced,
        graphId: graph.id,
        graphName: graph.name,
        scope: scope.level,
        nodeId: topic.id,
        type,
        title: topic.title,
        ...(topic.authority === undefined ? {} : { authority: topic.authority }),
        ...(topic.reviewStatus === undefined ? {} : { reviewStatus: topic.reviewStatus }),
        tags: [...topic.tags],
        docPath,
        ...(contributed ? { contributed: true, readOnly: true } : {}),
      })
      topics.push({
        ...topic,
        id: namespaced,
        domain: type,
        // The source graph is part of the card's identity in the overview; a tag
        // keeps it visible without adding a second rendering surface.
        tags: [graph.name, ...topic.tags],
        path: docPath,
        sourceGraphId: graph.id,
        sourceNodeId: topic.id,
        scope: scope.level,
        ...(contributed ? { contributed: true, readOnly: true } : {}),
      })
    }
  }

  for (const graph of readable) {
    const contributed = graph.scope !== scope.level
    for (const link of graph.links) {
      const from = graph.id + ':' + link.a
      const to = graph.id + ':' + link.b
      if (!nodeIndex.has(from) || !nodeIndex.has(to)) continue
      const stem = link.file === undefined ? link.a + '--' + link.b : link.file.replace(/\.md$/iu, '')
      edges.push({
        id: graph.id + ':' + stem,
        graphId: graph.id,
        edgeId: stem,
        from,
        to,
        type: link.label ?? 'related',
        ...(link.label === undefined ? {} : { title: link.label }),
        tags: [],
        sourceRefs: [],
        crossGraph: false,
        ...(contributed ? { contributed: true, readOnly: true } : {}),
      })
      links.push({
        a: from,
        b: to,
        ...(link.label === undefined ? {} : { label: link.label }),
        body: link.body,
        ...(link.file === undefined ? {} : { file: link.file }),
        ...(contributed ? { contributed: true } : {}),
      })
    }
  }

  let crossEdges = 0
  for (const record of crossLinks) {
    const fromGraph = findGraphReference(readable, record.fromGraph)
    const toGraph = findGraphReference(readable, record.toGraph)
    const from = fromGraph === undefined ? undefined : fromGraph.id + ':' + record.from
    const to = toGraph === undefined ? undefined : toGraph.id + ':' + record.to
    const missing = from === undefined || to === undefined
      || !nodeIndex.has(from) || !nodeIndex.has(to)
    if (missing) {
      // Never name the unreadable side: the id is the only thing that may cross
      // this boundary, and even that is generic enough not to disclose a name.
      issues.push('cross-graph link "' + record.id + '" was skipped: an endpoint is not readable')
      continue
    }
    crossEdges += 1
    const label = record.title ?? record.type
    const contributed = (fromGraph?.scope ?? scope.level) !== scope.level
      || (toGraph?.scope ?? scope.level) !== scope.level
    edges.push({
      id: record.id,
      graphId: scope.viewPath,
      edgeId: record.id,
      from,
      to,
      type: record.type,
      ...(record.title === undefined ? {} : { title: record.title }),
      authority: record.authority,
      origin: record.origin,
      reviewStatus: record.reviewStatus,
      tags: [...record.tags],
      sourceRefs: [...record.sourceRefs],
      crossGraph: true,
      ...(contributed ? { contributed: true, readOnly: true } : {}),
    })
    links.push({
      a: from,
      b: to,
      label,
      body: record.body ?? '',
      crossGraph: true,
      ...(contributed ? { contributed: true } : {}),
    })
  }

  const counts = {
    topics: nodes.length,
    links: edges.length,
    documents: nodes.length,
  }
  return {
    graph: {
      id: scope.viewPath,
      name: OVERVIEW_GRAPH_NAME,
      scope: scope.level,
      group: scope.groupLabel,
      path: scope.viewPath,
      format: 'overview',
      computed: true,
      readOnly: true,
      counts,
    },
    graphs: summaries,
    nodes,
    edges,
    topics,
    links,
    totals: { graphs: summaries.length, nodes: nodes.length, edges: edges.length, crossEdges },
    issues,
  }
}

/**
 * Load (or reuse) one scope's overview aggregate.
 *
 * The cache key covers the scope, every readable graph's identity/counts/attributes
 * and the cross-link snapshot, so a refresh or write changes the answer without a
 * TTL; {@link invalidateOverviewCache} still drops it eagerly on the write seams.
 * The store manager supplies the per-scope snapshot, so the same function serves
 * the global, department and personal overviews without mixing users' stores.
 */
export async function loadOverviewAggregate(
  host: KnowledgeGraphToolHost,
  graphs: readonly KnowledgeGraphNode[],
  scopeInput?: OverviewScopeInput | OverviewStoreScope,
  callerInput?: OverviewGraphCaller,
): Promise<OverviewAggregate> {
  const scope = scopeInput === undefined
    ? await personalOverviewScope(host)
    : ('viewPath' in scopeInput ? scopeInput : overviewStoreScope(scopeInput))
  const caller = callerInput ?? await resolveOverviewCaller(host)
  const acquired = await acquireOverviewStore(host, scope)
  try {
    const links = await acquired.store.query()
    const levelGraphs = graphsForLevel(caller, scope.level, graphs)
    const key = overviewSignature(scope, levelGraphs, links)
    let cache = overviewCache.get(host)
    if (cache === undefined) {
      cache = new Map()
      overviewCache.set(host, cache)
    }
    const cached = cache.get(scope.viewPath)
    if (cached !== undefined && cached.key === key) return cached.value
    const value = buildOverviewAggregate(scope, levelGraphs, links, acquired.store.issues())
    cache.set(scope.viewPath, { key, value })
    if (acquired.store instanceof JsonOverviewStore) {
      await acquired.store.materialize(value).catch(() => undefined)
    }
    return value
  } finally {
    releaseOverviewStore(host, acquired)
  }
}

/** The personal-only compatibility wrapper used by tests and early callers. */
export async function appendOverviewGraph(
  host: KnowledgeGraphToolHost,
  graphs: readonly KnowledgeGraphNode[],
): Promise<KnowledgeGraphNode[]> {
  const scope = await personalOverviewScope(host)
  return appendOverviewGraphs(host, graphs, [{
    level: scope.level,
    viewBase: scope.viewBase,
    actualBase: scope.actualBase,
    groupLabel: scope.groupLabel,
  }])
}

/** The `host.listGraphs()` answer plus one synthesized row per resolved scope. */
export async function appendOverviewGraphs(
  host: KnowledgeGraphToolHost,
  graphs: readonly KnowledgeGraphNode[],
  scopes: readonly OverviewScopeInput[],
  callerInput?: OverviewGraphCaller,
): Promise<KnowledgeGraphNode[]> {
  const real = graphs.filter(graph => !isOverviewGraph(graph))
  const caller = callerInput ?? await resolveOverviewCaller(host)
  const entries: KnowledgeGraphNode[] = []
  const seen = new Set<string>()
  for (const input of scopes) {
    const scope = overviewStoreScope(input)
    if (seen.has(scope.viewPath)) continue
    seen.add(scope.viewPath)
    const aggregate = await loadOverviewAggregate(host, real, scope, caller)
    entries.push(overviewGraphNode(scope, aggregate))
  }
  return [...real, ...entries]
}

/** `kg_get` for one overview: graphs, namespaced nodes and remapped edges. */
async function getOverview(
  host: KnowledgeGraphToolHost,
  graphs: readonly KnowledgeGraphNode[],
  overview: KnowledgeGraphNode,
): Promise<Record<string, unknown>> {
  const aggregate = await loadOverviewAggregate(host, graphs, overviewStoreScopeOf(overview))
  return {
    ok: true,
    overview: true,
    computed: true,
    readOnly: true,
    graph: aggregate.graph,
    totals: aggregate.totals,
    graphs: aggregate.graphs,
    nodes: aggregate.nodes,
    edges: aggregate.edges,
    ...(aggregate.issues.length === 0 ? {} : { issues: aggregate.issues }),
  }
}

/** `kg_add kind=edge` on an overview: one cross-graph link in that scope. */
async function addOverviewEdge(
  host: KnowledgeGraphToolHost,
  graphs: readonly KnowledgeGraphNode[],
  overview: KnowledgeGraphNode,
  args: {
    id?: string; fromGraph?: string; toGraph?: string; from?: string; to?: string
    type?: string; title?: string; authority?: string; internalizable?: boolean
    origin?: string; reviewStatus?: string; tags?: string[]; sourceRefs?: string[]; body?: string
    confirm?: boolean
  },
): Promise<Record<string, unknown>> {
  const scope = overviewStoreScopeOf(overview)
  const id = (args.id ?? '').trim()
  if (!GRAPH_ITEM_ID.test(id)) {
    throw new KnowledgeToolError('invalid', 'id must be 1-64 lowercase letters, digits or hyphens', id === '' ? undefined : id)
  }
  const fromGraphValue = (args.fromGraph ?? '').trim()
  const toGraphValue = (args.toGraph ?? '').trim()
  if (fromGraphValue === '' || toGraphValue === '') {
    throw new KnowledgeToolError(
      'invalid',
      'a cross-graph edge needs fromGraph and toGraph (each names a readable graph in this 总图 scope); from/to remain node ids',
      id,
    )
  }
  if (isOverviewGraph({ id: fromGraphValue, path: fromGraphValue })
    || isOverviewGraph({ id: toGraphValue, path: toGraphValue })) {
    throw new KnowledgeToolError('invalid', 'an overview cannot link to itself; name two source graphs', id)
  }
  const caller = await resolveOverviewCaller(host)
  const levelGraphs = graphsForLevel(caller, scope.level, graphs)
  const fromGraph = findGraphReference(levelGraphs, fromGraphValue)
  if (fromGraph === undefined) {
    throw new KnowledgeToolError(
      'not-found',
      'fromGraph must name exactly one readable graph in the ' + scope.level + ' scope',
      fromGraphValue,
    )
  }
  const toGraph = findGraphReference(levelGraphs, toGraphValue)
  if (toGraph === undefined) {
    throw new KnowledgeToolError(
      'not-found',
      'toGraph must name exactly one readable graph in the ' + scope.level + ' scope',
      toGraphValue,
    )
  }
  const from = (args.from ?? '').trim()
  const to = (args.to ?? '').trim()
  if (from === '' || to === '') throw new KnowledgeToolError('invalid', 'from and to are required node ids', id)
  if (fromGraph.id === toGraph.id && from === to) {
    throw new KnowledgeToolError('invalid', 'from and to must be different nodes', id)
  }
  if (!fromGraph.topics.some(topic => topic.id === from)) {
    throw new KnowledgeToolError('not-found', 'from node is not in ' + fromGraph.name + ': ' + from, from)
  }
  if (!toGraph.topics.some(topic => topic.id === to)) {
    throw new KnowledgeToolError('not-found', 'to node is not in ' + toGraph.name + ': ' + to, to)
  }
  const type = (args.type ?? '').trim()
  if (type === '') throw new KnowledgeToolError('invalid', 'type (the relation label) is required for an edge', id)
  const acquired = await acquireOverviewStore(host, scope)
  try {
    const store = acquired.store
    const existing = await store.query()
    assertOverviewLinksWritable(store, overview)
    if (existing.some(link => link.id === id)) {
      throw new KnowledgeToolError('exists', 'a cross-graph link with this id already exists', id)
    }
    const now = new Date().toISOString()
    const record: OverviewCrossLink = {
      id,
      fromGraph: fromGraph.id,
      from,
      toGraph: toGraph.id,
      to,
      type,
      ...(args.title === undefined || args.title.trim() === '' ? {} : { title: args.title.trim() }),
      authority: enumArg(args.authority, AUTHORITIES, 'authority') ?? 'advisory',
      internalizable: booleanArg(args.internalizable, 'internalizable') ?? true,
      origin: enumArg(args.origin, ORIGINS, 'origin') ?? 'human',
      reviewStatus: enumArg(args.reviewStatus, REVIEW_STATUSES, 'reviewStatus') ?? 'draft',
      tags: stringListArg(args.tags, 'tags') ?? [],
      sourceRefs: stringListArg(args.sourceRefs, 'sourceRefs') ?? [],
      ...(args.body === undefined || args.body.trim() === '' ? {} : { body: args.body }),
      createdAt: now,
      updatedAt: now,
    }
    const next = [...existing, record]
    const linksPath = overview.path + '/' + OVERVIEW_LINKS_FILE
    if (args.confirm !== true) {
      return {
        ok: true, draft: true, action: 'add', kind: 'edge', format: 'overview',
        graph: overview.path, scope: scope.level, id,
        fromGraph: fromGraph.id, toGraph: toGraph.id, from, to, type,
        path: linksPath, content: renderOverviewLinks(next),
        next: 'show this draft to the user; call again with confirm:true to write the cross-graph edge',
      }
    }
    await store.replace(next)
    invalidateOverviewCache(host)
    await host.refreshView().catch(() => undefined)
    const audit = await recordAudit(host, caller, {
      action: 'create', relPath: linksPath, tool: 'kg_add',
      graphId: overview.path, topicId: id, intent: 'new cross-graph edge',
      diffSummary: 'linked ' + fromGraph.id + ':' + from + ' -> ' + toGraph.id + ':' + to, outcome: 'applied',
    })
    return {
      ok: true, action: 'add', kind: 'edge', format: 'overview',
      graph: overview.path, scope: scope.level, id,
      fromGraph: fromGraph.id, toGraph: toGraph.id, from, to, type,
      path: linksPath, audit,
    }
  } finally {
    releaseOverviewStore(host, acquired)
  }
}

/** `kg_del` on an overview: move one cross-graph link to `_trash/links/`. */
async function deleteOverviewEdge(
  host: KnowledgeGraphToolHost,
  overview: KnowledgeGraphNode,
  args: { id: string; kind?: string; confirm?: boolean },
): Promise<Record<string, unknown>> {
  if (args.kind !== undefined && args.kind !== '' && args.kind !== 'edge') {
    throw new KnowledgeToolError('invalid', 'an overview only contains cross-graph edges; pass kind:"edge"', args.id)
  }
  const scope = overviewStoreScopeOf(overview)
  const id = args.id.trim()
  const caller = await host.resolveCaller()
  const acquired = await acquireOverviewStore(host, scope)
  try {
    const store = acquired.store
    const existing = await store.query()
    assertOverviewLinksWritable(store, overview)
    const record = existing.find(link => link.id === id)
    if (record === undefined) throw new KnowledgeToolError('not-found', 'no cross-graph link has this id', id)
    const trashName = stamp() + '-' + id + '.json'
    const trashPath = scope.actualPath + '/_trash/links/' + trashName
    const linksPath = overview.path + '/' + OVERVIEW_LINKS_FILE
    const summary = {
      action: 'del', kind: 'edge', format: 'overview', graph: overview.path, scope: scope.level, id,
      fromGraph: record.fromGraph, toGraph: record.toGraph, from: record.from, to: record.to,
      path: linksPath,
      toPath: overview.path + '/_trash/links/' + trashName,
    }
    if (args.confirm !== true) {
      return {
        ok: true, draft: true, ...summary,
        next: 'show these paths to the user; call again with confirm:true to move the cross-graph link to _trash',
      }
    }
    if (!await host.canWrite(scope.actualPath)) {
      throw new KnowledgeToolError('forbidden', 'write access is required for this overview scope', overview.path)
    }
    await host.createEntry(scope.actualPath + '/_trash/links', { directory: true }).catch(() => undefined)
    await host.createEntry(trashPath, { directory: false, content: JSON.stringify(record, null, 2) + '\n' })
    await store.replace(existing.filter(link => link.id !== id))
    invalidateOverviewCache(host)
    await host.refreshView().catch(() => undefined)
    const audit = await recordAudit(host, caller, {
      action: 'delete', relPath: linksPath,
      toRelPath: overview.path + '/_trash/links/' + trashName,
      tool: 'kg_del', graphId: overview.path, topicId: id, intent: 'move-to-trash',
      diffSummary: 'removed cross-graph edge ' + id, outcome: 'applied',
    })
    return { ok: true, ...summary, movedToTrash: true, audit }
  } finally {
    releaseOverviewStore(host, acquired)
  }
}

/** Refuse a write over a `links.json` this store could not parse. */
function assertOverviewLinksWritable(store: OverviewStore, overview: KnowledgeGraphNode): void {
  const broken = store.issues().some(issue => (
    issue.startsWith('links.json is not valid JSON')
    || issue.startsWith('links.json must be')
  ))
  if (broken) {
    throw new KnowledgeToolError(
      'invalid',
      'links.json is unreadable; repair or remove it before writing cross-graph edges',
      overview.path,
    )
  }
}

/** `kg_set`/`kg_add kind=node` on an overview: an actionable refusal. */
function overviewReadOnly(field: 'node' | 'item'): KnowledgeToolError {
  return new KnowledgeToolError(
    'invalid',
    'the 总图 overview is computed and read-only: '
      + (field === 'node'
        ? 'add the node to its source graph with kg_add {"kind":"node","graph":"<source-graph>",...}; it then appears in that scope\'s 总图 automatically'
        : 'edit the source graph or node with kg_set graph=<source-graph> id=<node-or-edge-id>'),
  )
}

/** Drop every cached aggregate for one host; called on the write seams and refresh. */
export function invalidateOverviewCache(host: KnowledgeGraphToolHost): void {
  overviewCache.delete(host)
}

/** The scope base that owns one graph path, legacy or graph-json. */
function scopeBaseOfPath(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  const store = storePathParts(value)
  if (store !== undefined) return store.base
  // A legacy graph is `<scopeBase>/知识图谱/<name>`; the manifest of a graph-json
  // graph is `<scopeBase>/.graphs/<id>`, already handled by storePathParts.
  const parts = value.split('/')
  if (parts.length >= 3 && parts[parts.length - 2] === KNOWLEDGE_GRAPH_FOLDER) {
    return parts.slice(0, -2).join('/')
  }
  return undefined
}

/**
 * Resolve where a new graph goes.
 *
 * `personal` is the default and the only scope whose authoritative path differs
 * from its view path (it gains the caller's owner segment). `department` reuses
 * the department path of an existing readable department graph, because the
 * model never sees department codes; an explicit `department/<chain>` is accepted
 * for the first graph, and `canWrite` still decides whether the caller may write
 * there. `global` is admin-only in practice for the same reason.
 */
function resolveGraphCreateTarget(
  graphs: readonly KnowledgeGraphNode[],
  value: string | undefined,
  caller: { userId: string },
): GraphCreateTarget {
  const raw = (value ?? '').trim()
  const scope = raw === '' ? 'personal' : (scopeFromAlias(raw) ?? raw)
  if (scope === 'personal') {
    if (!isSafeSegment(caller.userId)) {
      throw new KnowledgeToolError('forbidden', 'unsafe caller id; cannot resolve the personal scope')
    }
    return {
      key: 'personal',
      viewBase: 'personal',
      actualBase: 'personal/' + caller.userId,
      manifestScope: 'personal:' + caller.userId,
      visibility: 'private',
    }
  }
  if (scope === 'global') {
    return { key: 'global', viewBase: 'global', actualBase: 'global', manifestScope: 'global', visibility: 'global' }
  }
  if (scope === 'department') {
    // Reuse the department path of an existing readable graph. View and actual
    // bases are derived separately: a legacy flat graph is linked at
    // `department/知识图谱` while its bytes live at `department/<code>/知识图谱`, so
    // the two coordinate systems genuinely differ there.
    const existing = graphs.find(graph => graph.scope === 'department'
      && !isOverviewGraph(graph)
      && scopeBaseOfPath(graph.actualPath) !== undefined
      && scopeBaseOfPath(graph.path) !== undefined)
    const viewBase = existing === undefined ? undefined : scopeBaseOfPath(existing.path)
    const actualBase = existing === undefined ? undefined : scopeBaseOfPath(existing.actualPath)
    if (viewBase === undefined || actualBase === undefined) {
      throw new KnowledgeToolError(
        'invalid',
        'this caller has no readable department graph to copy the department path from; '
          + 'pass scope:"department/<chain>" (the department path in the graph tree) to create one',
      )
    }
    return {
      key: 'department',
      viewBase,
      actualBase,
      manifestScope: 'department:' + actualBase.replace(/^department\//u, ''),
      visibility: 'department',
    }
  }
  if (scope.startsWith('department/')) {
    if (!isSafeRelPath(scope) || scope === 'department') {
      throw new KnowledgeToolError('invalid', 'scope "department/<chain>" must be a safe relative path')
    }
    return {
      key: 'department',
      viewBase: scope,
      actualBase: scope,
      manifestScope: 'department:' + scope.slice('department/'.length),
      visibility: 'department',
    }
  }
  throw new KnowledgeToolError(
    'invalid',
    'scope must be one of ' + GRAPH_CREATE_SCOPES.join(', ') + ' or an explicit department/<chain> path',
  )
}

/** The manifest a freshly created graph holds: metadata only, no topology yet. */
function newGraphManifest(input: {
  id: string
  name: string
  description?: string
  target: GraphCreateTarget
  owner: string
  tags: readonly string[]
  now: string
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: input.id,
    name: input.name,
    ...(input.description === undefined || input.description === '' ? {} : { description: input.description }),
    scope: input.target.manifestScope,
    version: 1,
    status: 'draft',
    owner: input.owner,
    createdAt: input.now,
    updatedAt: input.now,
    tags: [...input.tags],
    visibility: input.target.visibility,
    defaultView: { layout: 'hierarchy', direction: 'TB' },
    topics: [],
    nodes: [],
    edges: [],
  }
}

/** Whether a value names a create scope rather than a graph id or name. */
function isGraphCreateScope(value: string): boolean {
  const normalized = scopeFromAlias(value) ?? value
  return normalized === 'personal' || normalized === 'department' || normalized === 'global'
    || normalized.startsWith('department/')
}

/** `kg_add kind="graph"` for a new `.graphs/<id>/graph.json` graph. */
async function createGraphJson(
  host: KnowledgeGraphToolHost,
  args: {
    graph?: string; id?: string; name?: string; title?: string; scope?: string; description?: string
    tags?: string[]; confirm?: boolean
  },
): Promise<Record<string, unknown>> {
  // A model that learned the other kinds often puts the new graph's id (or the
  // scope) in `graph`. Accept both spellings instead of creating the wrong graph.
  const graphArg = (args.graph ?? '').trim()
  const graphArgIsScope = graphArg !== '' && isGraphCreateScope(graphArg)
  const id = (args.id ?? (GRAPH_ITEM_ID.test(graphArg) && !graphArgIsScope ? graphArg : '')).trim()
  if (!GRAPH_ITEM_ID.test(id)) {
    throw new KnowledgeToolError('invalid', 'graph id must be 1-64 lowercase letters, digits or hyphens', id === '' ? undefined : id)
  }
  if (id === OVERVIEW_GRAPH_ID) {
    throw new KnowledgeToolError('invalid', 'graph id "__overview__" is reserved for the computed 总图', id)
  }
  const scopeValue = args.scope ?? (graphArgIsScope ? graphArg : undefined)
  const name = (args.name ?? args.title ?? '').trim()
  if (name === '') throw new KnowledgeToolError('invalid', 'name is required to create a graph')
  if (name === OVERVIEW_GRAPH_NAME) {
    throw new KnowledgeToolError('exists', '"总图" is the reserved name of the computed overview graph')
  }
  if (name.length > 120) throw new KnowledgeToolError('invalid', 'name must be at most 120 characters')
  const description = (args.description ?? '').trim()
  if (description.length > 2000) throw new KnowledgeToolError('invalid', 'description must be at most 2000 characters')
  const tags = stringListArg(args.tags, 'tags') ?? []
  const caller = await host.resolveCaller()
  const graphs = await host.listGraphs()
  const target = resolveGraphCreateTarget(graphs, scopeValue, caller)
  const viewStorePath = joinRel(target.viewBase, '.graphs/' + id)
  const actualStorePath = joinRel(target.actualBase, '.graphs/' + id)
  const manifestRel = '.graphs/' + id + '/graph.json'

  if (graphs.some(graph => graph.scope === target.key && graph.path === viewStorePath)) {
    throw new KnowledgeToolError('exists', 'a graph with this id already exists in this scope', viewStorePath)
  }
  if (graphs.some(graph => graph.scope === target.key && graph.name.trim() === name)) {
    throw new KnowledgeToolError('exists', 'a graph with this name already exists in this scope', name)
  }
  // An unreadable or half-written `.graphs/<id>` directory is not in `listGraphs`,
  // but creating on top of it would silently adopt its bytes. Refuse instead: the
  // model can pick another id or repair the directory explicitly.
  if (await host.statEntry(viewStorePath) !== undefined) {
    throw new KnowledgeToolError('exists', 'a .graphs directory already exists for this graph id', viewStorePath)
  }
  // The create target does not exist yet, so `canWrite` decides on the scope path
  // and its ancestors. Checking here also refuses an unauthorized draft instead of
  // handing the model a draft it can never confirm.
  if (!await host.canWrite(actualStorePath)) {
    throw new KnowledgeToolError('forbidden', 'write access is required for this scope', target.viewBase)
  }

  const now = new Date().toISOString()
  const manifest = newGraphManifest({ id, name, ...(description === '' ? {} : { description }), target, owner: caller.userId, tags, now })
  const content = JSON.stringify(manifest, null, 2) + '\n'
  if (args.confirm !== true) {
    return {
      ok: true, draft: true, action: 'create', kind: 'graph', format: 'graph-json',
      graph: viewStorePath, id, name, scope: target.key, scopePath: target.viewBase,
      path: viewStorePath, manifestPath: manifestRel, visibility: target.visibility, content,
      next: 'show this draft to the user; call again with confirm:true to create the graph',
    }
  }

  try {
    await host.createEntry(joinRel(viewStorePath, 'graph.json'), { directory: false, content })
  } catch (error) {
    if (error instanceof KnowledgeToolError) throw error
    if ((error as { code?: string }).code === 'exists') {
      throw new KnowledgeToolError('exists', 'a graph already exists at this path', viewStorePath)
    }
    throw asKnowledgeToolError(error)
  }
  await host.refreshView().catch(() => undefined)

  // Validate through the same loader every reader uses, so a manifest that the
  // projection would refuse cannot be reported as created. The authoritative
  // personal base differs by deployment: a team tree is `personal/<uid>/…`, while
  // a standalone install keeps the flat `personal/…` spelling. Rather than guess,
  // validate the team spelling first and fall back to the view spelling; the
  // manifest is generated here, so a failure of the first spelling on a standalone
  // install can only mean the write landed at the flat path.
  const candidateBases = target.key === 'personal' && target.actualBase !== target.viewBase
    ? [target.actualBase, target.viewBase]
    : [target.actualBase]
  let validated = false
  let validationError: unknown
  for (const actualBase of candidateBases) {
    const graph: KnowledgeGraphNode & { format: string } = {
      id: viewStorePath,
      name,
      scope: target.key,
      path: viewStorePath,
      group: '',
      topics: [],
      links: [],
      counts: { topics: 0, links: 0, documents: 0 },
      actualPath: joinRel(actualBase, '.graphs/' + id),
      format: 'graph-json',
    }
    const store: GraphJsonStore = {
      graph,
      graphId: id,
      viewBase: target.viewBase,
      actualBase,
      viewStorePath,
      actualStorePath: joinRel(actualBase, '.graphs/' + id),
    }
    try {
      requireValidGraph(await validateGraphStore(host, store), store)
      validated = true
      break
    } catch (error) {
      validationError = error
    }
  }
  if (!validated) {
    const cleanupStore: GraphJsonStore = {
      graph: {
        id: viewStorePath, name, scope: target.key, path: viewStorePath, group: '',
        topics: [], links: [], counts: { topics: 0, links: 0, documents: 0 },
        actualPath: viewStorePath, format: 'graph-json',
      } as KnowledgeGraphNode & { format: string },
      graphId: id,
      viewBase: target.viewBase,
      actualBase: target.viewBase,
      viewStorePath,
      actualStorePath: viewStorePath,
    }
    await moveToTrash(host, cleanupStore, caller, joinRel(viewStorePath, 'graph.json'), 'rejected/graphs', stamp() + '-graph.json')
      .catch(() => undefined)
    throw validationError
  }
  await host.refreshView().catch(() => undefined)
  const audit = await recordAudit(host, caller, {
    action: 'create', relPath: viewStorePath, tool: 'kg_add', graphId: viewStorePath,
    intent: 'new graph', diffSummary: 'created graph ' + name, outcome: 'applied',
  })
  return {
    ok: true, action: 'create', kind: 'graph', format: 'graph-json',
    graph: viewStorePath, id, name, scope: target.key, scopePath: target.viewBase,
    path: viewStorePath, manifestPath: manifestRel, visibility: target.visibility, audit,
    next: 'add the first node with kg_add {"kind":"node","graph":' + JSON.stringify(viewStorePath)
      + ',"id":"<node-id>","path":"<分类/文档.md>","title":"<标题>"} (draft, then confirm:true)',
  }
}

/** `kg_add` for a `.graphs/<id>/graph.json` graph. */
async function addToGraphJson(
  host: KnowledgeGraphToolHost,
  graph: KnowledgeGraphNode,
  store: GraphJsonStore,
  args: {
    kind: string; id?: string; title?: string; path?: string; type?: string; authority?: string
    internalizable?: boolean; origin?: string; reviewStatus?: string; tags?: string[]; sourceRefs?: string[]
    body?: string; from?: string; to?: string; confirm?: boolean
  },
): Promise<Record<string, unknown>> {
  const state = await loadGraphJsonState(host, store)
  const id = (args.id ?? '').trim()
  if (!GRAPH_ITEM_ID.test(id)) {
    throw new KnowledgeToolError('invalid', 'id must be 1-64 lowercase letters, digits or hyphens', id === '' ? undefined : id)
  }
  if (graphJsonIdTaken(state, id)) {
    throw new KnowledgeToolError('exists', 'an item with this id already exists', id)
  }
  const body = args.body ?? ''

  if (args.kind === 'node') {
    const nodePath = (args.path ?? '').trim()
    if (!isSafeNodePath(nodePath)) {
      throw new KnowledgeToolError(
        'invalid',
        'path must be a scope-relative .md document path outside .graphs, .kg and _trash',
        nodePath === '' ? undefined : nodePath,
      )
    }
    if (state.nodes.some(node => node.path === nodePath)) {
      throw new KnowledgeToolError('exists', 'a node already references this path', nodePath)
    }
    const title = (args.title ?? '').trim()
    if (title === '') throw new KnowledgeToolError('invalid', 'title is required')
    const attributes: GraphNodeAttributes = {
      id,
      type: enumArg(args.type, NODE_TYPES, 'type') ?? 'fact',
      title,
      authority: enumArg(args.authority, AUTHORITIES, 'authority') ?? 'advisory',
      internalizable: booleanArg(args.internalizable, 'internalizable') ?? true,
      origin: enumArg(args.origin, ORIGINS, 'origin') ?? 'human',
      reviewStatus: enumArg(args.reviewStatus, REVIEW_STATUSES, 'reviewStatus') ?? 'draft',
      tags: stringListArg(args.tags, 'tags') ?? [],
      sourceRefs: stringListArg(args.sourceRefs, 'sourceRefs') ?? [],
    }
    const content = renderNodeDocument(attributes, body)
    const viewPath = joinRel(store.viewBase, nodePath)
    const actualPath = joinRel(store.actualBase, nodePath)
    if (args.confirm !== true) {
      return {
        ok: true, draft: true, action: 'add', kind: 'node', format: 'graph-json',
        graph: graph.path, id, path: viewPath, manifestPath: nodePath, content,
        next: 'show this draft to the user; call again with confirm:true to write it',
      }
    }
    const caller = await requireGraphJsonWrite(host, store, actualPath)
    if (await statFile(host, actualPath) !== undefined) {
      throw new KnowledgeToolError('exists', 'a document already exists at this path', nodePath)
    }
    await host.createEntry(actualPath, { directory: false, content })
    // The post-write validator reads the new document back through the caller's
    // view; a fresh file only appears there after the view sync this write forces.
    await host.refreshView(actualPath).catch(() => undefined)
    const nodes = [...state.manifest.nodes, { id, path: nodePath }]
    const commit = await commitManifest(host, store, caller, nextManifestRecord(state, nodes, state.manifest.edges), state.manifestText)
    try {
      requireValidGraph(await validateGraphStore(host, store), store)
    } catch (error) {
      await rollbackManifest(host, store, caller, commit)
      await moveToTrash(host, store, caller, actualPath, 'rejected/nodes', `${stamp()}-${id}-${titleFromPath(nodePath)}`).catch(() => undefined)
      throw error
    }
    await host.refreshView().catch(() => undefined)
    const audit = await recordAudit(host, caller, {
      action: 'create', relPath: viewPath, tool: 'kg_add', graphId: graph.path,
      topicId: id, intent: 'new graph node', diffSummary: 'created node ' + title, outcome: 'applied',
    })
    return { ok: true, action: 'add', kind: 'node', format: 'graph-json', graph: graph.path, id, path: viewPath, manifestPath: nodePath, audit }
  }

  if (args.kind === 'edge') {
    const from = (args.from ?? '').trim()
    const to = (args.to ?? '').trim()
    if (from === '' || to === '') throw new KnowledgeToolError('invalid', 'from and to are required', id)
    if (from === to) throw new KnowledgeToolError('invalid', 'from and to must be different nodes', id)
    for (const endpoint of [from, to]) {
      if (!state.nodes.some(node => node.id === endpoint)) {
        throw new KnowledgeToolError('not-found', 'edge endpoint is not a node in this graph: ' + endpoint, endpoint)
      }
    }
    const type = (args.type ?? '').trim()
    if (type === '') throw new KnowledgeToolError('invalid', 'type (the relation label) is required for an edge', id)
    const authority = enumArg(args.authority, AUTHORITIES, 'authority') ?? 'advisory'
    const internalizable = booleanArg(args.internalizable, 'internalizable') ?? true
    const origin = enumArg(args.origin, ORIGINS, 'origin') ?? 'human'
    const reviewStatus = enumArg(args.reviewStatus, REVIEW_STATUSES, 'reviewStatus') ?? 'draft'
    const title = (args.title ?? '').trim()
    const wantsDoc = body.trim() !== ''
      || args.authority !== undefined || args.internalizable !== undefined
      || args.origin !== undefined || args.reviewStatus !== undefined
      || args.tags !== undefined || args.sourceRefs !== undefined || title !== ''
    const docPath = edgeDocPath(store.graphId, id)
    const content = wantsDoc
      ? renderEdgeDocument({
        id, from, to, type, authority, internalizable, origin, reviewStatus,
        ...(title === '' ? {} : { title }),
        ...(args.tags === undefined ? {} : { tags: stringListArg(args.tags, 'tags') ?? [] }),
        ...(args.sourceRefs === undefined ? {} : { sourceRefs: stringListArg(args.sourceRefs, 'sourceRefs') ?? [] }),
      }, body)
      : undefined
    const viewPath = joinRel(store.viewBase, docPath)
    const actualPath = joinRel(store.actualBase, docPath)
    if (args.confirm !== true) {
      return {
        ok: true, draft: true, action: 'add', kind: 'edge', format: 'graph-json',
        graph: graph.path, id, from, to, type,
        ...(content === undefined ? {} : { doc: docPath, content }),
        next: 'show this draft to the user; call again with confirm:true to write it',
      }
    }
    const caller = await requireGraphJsonWrite(host, store, actualPath)
    if (content !== undefined) {
      if (await statFile(host, actualPath) !== undefined) {
        throw new KnowledgeToolError('exists', 'a relation document already exists at this path', docPath)
      }
      await host.createEntry(actualPath, { directory: false, content })
      // Same reason as a node: the validator reads the relation document through
      // the caller's view, which only knows the file after a sync.
      await host.refreshView(actualPath).catch(() => undefined)
    }
    const edges = [...state.manifest.edges, {
      id, from, to, type,
      ...(content === undefined ? {} : { doc: docPath }),
    }]
    const commit = await commitManifest(host, store, caller, nextManifestRecord(state, state.manifest.nodes, edges), state.manifestText)
    try {
      requireValidGraph(await validateGraphStore(host, store), store)
    } catch (error) {
      await rollbackManifest(host, store, caller, commit)
      if (content !== undefined) {
        await moveToTrash(host, store, caller, actualPath, 'rejected/links', `${stamp()}-${id}.md`).catch(() => undefined)
      }
      throw error
    }
    await host.refreshView().catch(() => undefined)
    const audit = await recordAudit(host, caller, {
      action: 'create', relPath: content === undefined ? graph.path : viewPath, tool: 'kg_add',
      graphId: graph.path, topicId: id, intent: 'new graph edge', diffSummary: `linked ${from} -> ${to} (${type})`,
      outcome: 'applied',
    })
    return {
      ok: true, action: 'add', kind: 'edge', format: 'graph-json', graph: graph.path, id, from, to, type,
      ...(content === undefined ? {} : { path: viewPath, doc: docPath }), audit,
    }
  }

  throw new KnowledgeToolError('invalid', 'kind must be node or edge for a graph-json graph')
}

/** `kg_get` for a `.graphs/<id>/graph.json` graph. */
async function getFromGraphJson(
  host: KnowledgeGraphToolHost,
  graph: KnowledgeGraphNode,
  store: GraphJsonStore,
  id: string | undefined,
): Promise<Record<string, unknown>> {
  const state = await loadGraphJsonState(host, store)
  const header = {
    id: graph.id,
    name: graph.name,
    scope: graph.scope,
    group: graph.group,
    path: graph.path,
    format: 'graph-json',
    counts: graph.counts,
  }
  if (id === undefined || id.trim() === '') {
    return {
      ok: true,
      graph: header,
      nodes: state.nodes.map(node => nodeSummary(store, node)),
      edges: state.edges.map(edge => edgeSummary(store, edge)),
      issues: state.issues,
    }
  }
  const target = resolveGraphJsonTarget(state, id.trim(), undefined)
  if (target.node !== undefined) {
    const node = target.node
    let summary: string | undefined
    let body: string | undefined
    if (!node.missing) {
      try {
        const source = await readScopeText(host, store, node.path)
        const split = splitDocument(source)
        summary = firstSummary(split.body)
        body = split.body
      } catch {
        // The node was loaded as missing; the summary is simply not available.
      }
    }
    return {
      ok: true,
      graph: header,
      node: {
        ...nodeSummary(store, node),
        ...(summary === undefined ? {} : { summary }),
        ...(body === undefined ? {} : { body }),
      },
      edges: state.edges.filter(edge => edge.from === node.id || edge.to === node.id).map(edge => edgeSummary(store, edge)),
      issues: state.issues,
    }
  }
  const edge = target.edge!
  return { ok: true, graph: header, edge: edgeSummary(store, edge), issues: state.issues }
}

/** `kg_set` for a `.graphs/<id>/graph.json` graph: front matter and relation documents only. */
async function setOnGraphJson(
  host: KnowledgeGraphToolHost,
  graph: KnowledgeGraphNode,
  store: GraphJsonStore,
  args: {
    id: string; kind?: string; title?: string; domain?: string; status?: string; depth?: number
    summary?: string; body?: string; type?: string; authority?: string; internalizable?: boolean
    origin?: string; reviewStatus?: string; tags?: string[]; sourceRefs?: string[]; confirm?: boolean
  },
): Promise<Record<string, unknown>> {
  const state = await loadGraphJsonState(host, store)
  const target = resolveGraphJsonTarget(state, args.id.trim(), args.kind)

  if (target.node !== undefined) {
    const node = target.node
    const unsupported = [
      args.domain === undefined ? undefined : 'domain',
      args.status === undefined ? undefined : 'status',
      args.depth === undefined ? undefined : 'depth',
      args.summary === undefined ? undefined : 'summary',
      args.body === undefined ? undefined : 'body',
    ].filter((field): field is string => field !== undefined)
    if (unsupported.length > 0) {
      throw new KnowledgeToolError(
        'invalid',
        'a graph-json node has no card fields to edit (' + unsupported.join(', ')
          + '); pass title/type/authority/internalizable/origin/reviewStatus/tags/sourceRefs',
        node.id,
      )
    }
    if (node.missing) throw new KnowledgeToolError('not-found', 'the node document is missing; add it first', node.path)
    const type = enumArg(args.type, NODE_TYPES, 'type') ?? node.type
    const authority = enumArg(args.authority, AUTHORITIES, 'authority') ?? node.authority
    const internalizable = booleanArg(args.internalizable, 'internalizable') ?? node.internalizable
    const origin = enumArg(args.origin, ORIGINS, 'origin') ?? node.origin
    const reviewStatus = enumArg(args.reviewStatus, REVIEW_STATUSES, 'reviewStatus') ?? node.reviewStatus
    const tags = stringListArg(args.tags, 'tags') ?? node.tags
    const sourceRefs = stringListArg(args.sourceRefs, 'sourceRefs') ?? node.sourceRefs
    const title = (args.title ?? node.title).trim()
    if (title === '') throw new KnowledgeToolError('invalid', 'title must not be empty', node.id)
    const after: GraphNodeAttributes = {
      id: node.id, type, title, authority, internalizable, origin, reviewStatus, tags, sourceRefs,
    }
    const changed = (Object.keys(after) as Array<keyof GraphNodeAttributes>)
      .filter(key => key !== 'id' && JSON.stringify(after[key]) !== JSON.stringify(node[key]))
    if (changed.length === 0) throw new KnowledgeToolError('invalid', 'no attribute would change', node.id)

    const actualPath = joinRel(store.actualBase, node.path)
    const viewPath = nodeViewPath(store, node)
    const info = await statFile(host, actualPath)
    if (info === undefined || info.kind !== 'file') throw new KnowledgeToolError('not-found', 'the node document is missing', node.path)
    if ((info.size ?? 0) > GRAPH_JSON_TEXT_LIMIT) {
      throw new KnowledgeToolError('too-large', 'the node document is larger than the readable window', node.path)
    }
    const previous = await readScopeText(host, store, node.path)
    const split = splitDocument(previous)
    if (split.hasBlock && !split.closed) {
      throw new KnowledgeToolError('invalid', 'the node front matter block is not closed with ---', node.path)
    }
    const content = rewriteFrontMatter(split, nodeFrontMatterFields(after))
    const before = {
      title: node.title, type: node.type, authority: node.authority, internalizable: node.internalizable,
      origin: node.origin, reviewStatus: node.reviewStatus, tags: node.tags, sourceRefs: node.sourceRefs,
    }
    if (args.confirm !== true) {
      return {
        ok: true, draft: true, action: 'set', kind: 'node', format: 'graph-json',
        graph: graph.path, id: node.id, path: viewPath, before, after, content,
        next: 'show this draft to the user; call again with confirm:true to write it',
      }
    }
    const caller = await requireGraphJsonWrite(host, store, actualPath)
    await host.overwriteFile(actualPath, content)
    try {
      requireValidGraph(await validateGraphStore(host, store), store)
    } catch (error) {
      await host.overwriteFile(actualPath, previous)
      throw error
    }
    await host.refreshView().catch(() => undefined)
    const audit = await recordAudit(host, caller, {
      action: 'edit', relPath: viewPath, tool: 'kg_set', graphId: graph.path, topicId: node.id,
      intent: 'update node attributes', diffSummary: 'updated ' + changed.join(', '), outcome: 'applied',
    })
    return { ok: true, action: 'set', kind: 'node', format: 'graph-json', graph: graph.path, id: node.id, after, audit }
  }

  const edge = target.edge!
  const unsupported = [
    args.title === undefined ? undefined : 'title',
    args.domain === undefined ? undefined : 'domain',
    args.status === undefined ? undefined : 'status',
    args.depth === undefined ? undefined : 'depth',
    args.summary === undefined ? undefined : 'summary',
    args.origin === undefined ? undefined : 'origin',
    args.reviewStatus === undefined ? undefined : 'reviewStatus',
    args.tags === undefined ? undefined : 'tags',
    args.sourceRefs === undefined ? undefined : 'sourceRefs',
  ].filter((field): field is string => field !== undefined)
  if (unsupported.length > 0) {
    throw new KnowledgeToolError(
      'invalid',
      'a graph-json edge only supports type, authority, internalizable and a relation-document body (got '
        + unsupported.join(', ') + ')',
      edge.id,
    )
  }
  const type = (args.type ?? edge.type).trim()
  if (type === '') throw new KnowledgeToolError('invalid', 'type must not be empty', edge.id)
  const authority = enumArg(args.authority, AUTHORITIES, 'authority') ?? edge.authority
  const internalizable = booleanArg(args.internalizable, 'internalizable') ?? edge.internalizable
  const body = args.body
  const changed: string[] = []
  if (type !== edge.type) changed.push('type')
  if (authority !== edge.authority) changed.push('authority')
  if (internalizable !== edge.internalizable) changed.push('internalizable')
  if (body !== undefined) changed.push('body')
  if (changed.length === 0) throw new KnowledgeToolError('invalid', 'no edge field would change', edge.id)

  const manifestDoc = edge.docPath ?? edgeDocPath(store.graphId, edge.id)
  const actualDoc = joinRel(store.actualBase, manifestDoc)
  const viewDoc = joinRel(store.viewBase, manifestDoc)
  let previousDoc: string | undefined
  if (!edge.missing && edge.docPath !== undefined) {
    const info = await statFile(host, actualDoc)
    if (info !== undefined && info.kind === 'file') {
      if ((info.size ?? 0) > GRAPH_JSON_TEXT_LIMIT) {
        throw new KnowledgeToolError('too-large', 'the relation document is larger than the readable window', manifestDoc)
      }
      previousDoc = await readScopeText(host, store, manifestDoc)
    }
  }
  let content: string
  if (previousDoc !== undefined) {
    const split = splitDocument(previousDoc)
    if (split.hasBlock && !split.closed) {
      throw new KnowledgeToolError('invalid', 'the relation front matter block is not closed with ---', manifestDoc)
    }
    const fields = [
      ['id', yamlScalar(edge.id)],
      ['from', yamlScalar(edge.from)],
      ['to', yamlScalar(edge.to)],
      ['type', yamlScalar(type)],
      ['authority', authority],
      ['internalizable', String(internalizable)],
    ] as Array<[string, string]>
    content = rewriteFrontMatter(split, fields)
    if (body !== undefined) content = content.slice(0, content.length - split.body.length) + (body.trim() === '' ? '' : '\n' + body.trim() + '\n')
  } else {
    content = renderEdgeDocument({
      id: edge.id, from: edge.from, to: edge.to, type, authority, internalizable,
      origin: edge.origin, reviewStatus: edge.reviewStatus,
      ...(edge.tags.length === 0 ? {} : { tags: edge.tags }),
      ...(edge.sourceRefs.length === 0 ? {} : { sourceRefs: edge.sourceRefs }),
    }, body ?? '')
  }

  if (args.confirm !== true) {
    return {
      ok: true, draft: true, action: 'set', kind: 'edge', format: 'graph-json',
      graph: graph.path, id: edge.id, doc: manifestDoc, before: {
        type: edge.type, authority: edge.authority, internalizable: edge.internalizable, missing: edge.missing,
      }, after: { type, authority, internalizable }, content,
      next: 'show this draft to the user; call again with confirm:true to write it',
    }
  }
  const caller = await requireGraphJsonWrite(host, store, actualDoc)
  if (previousDoc === undefined) {
    if (await statFile(host, actualDoc) !== undefined) {
      throw new KnowledgeToolError('exists', 'a relation document already exists at this path', manifestDoc)
    }
    await host.createEntry(actualDoc, { directory: false, content })
    await host.refreshView(actualDoc).catch(() => undefined)
  } else {
    await host.overwriteFile(actualDoc, content)
  }
  const manifestChanged = type !== edge.type || edge.docPath === undefined
  let commit: ManifestCommit | undefined
  if (manifestChanged) {
    const edges = state.manifest.edges.map(item => {
      if (item.id !== edge.id) return item
      return { id: item.id, from: item.from, to: item.to, type, doc: item.doc ?? manifestDoc }
    })
    commit = await commitManifest(host, store, caller, nextManifestRecord(state, state.manifest.nodes, edges), state.manifestText)
  }
  try {
    requireValidGraph(await validateGraphStore(host, store), store)
  } catch (error) {
    if (commit !== undefined) await rollbackManifest(host, store, caller, commit)
    if (previousDoc !== undefined) await host.overwriteFile(actualDoc, previousDoc)
    else await moveToTrash(host, store, caller, actualDoc, 'rejected/links', `${stamp()}-${edge.id}.md`).catch(() => undefined)
    throw error
  }
  await host.refreshView().catch(() => undefined)
  const audit = await recordAudit(host, caller, {
    action: 'edit', relPath: viewDoc, tool: 'kg_set', graphId: graph.path, topicId: edge.id,
    intent: 'update edge', diffSummary: 'updated ' + changed.join(', '), outcome: 'applied',
  })
  return { ok: true, action: 'set', kind: 'edge', format: 'graph-json', graph: graph.path, id: edge.id, doc: manifestDoc, after: { type, authority, internalizable }, audit }
}

/** `kg_del` for a `.graphs/<id>/graph.json` graph: move to `_trash`, never delete. */
async function deleteFromGraphJson(
  host: KnowledgeGraphToolHost,
  graph: KnowledgeGraphNode,
  store: GraphJsonStore,
  args: { id: string; kind?: string; cascade?: boolean; force?: boolean; confirm?: boolean },
): Promise<Record<string, unknown>> {
  if (args.force === true) {
    throw new KnowledgeToolError('invalid', 'a graph-json graph uses cascade:true, not force:true', args.id)
  }
  const state = await loadGraphJsonState(host, store)
  const target = resolveGraphJsonTarget(state, args.id.trim(), args.kind)

  if (target.node !== undefined) {
    const node = target.node
    const incident = state.edges.filter(edge => edge.from === node.id || edge.to === node.id)
    const nodeActual = joinRel(store.actualBase, node.path)
    const nodeView = nodeViewPath(store, node)
    const base = titleFromPath(node.path)
    const tag = stamp()
    const trashName = `${tag}-${node.id}-${base}`
    const summary = {
      action: 'del', kind: 'node', format: 'graph-json', graph: graph.path, id: node.id,
      path: nodeView,
      nodeTo: node.missing ? undefined : joinRel(store.viewStorePath, `_trash/nodes/${trashName}`),
      edges: incident.map(edge => ({
        id: edge.id, from: edge.from, to: edge.to, type: edge.type, doc: edge.docPath,
      })),
      needsCascade: incident.length > 0 && args.cascade !== true,
    }
    if (args.confirm !== true) {
      return {
        ok: true, draft: true, ...summary,
        next: incident.length > 0 && args.cascade !== true
          ? 'show the incident edges to the user; call again with confirm:true and cascade:true to remove them and move every document to _trash'
          : 'show these paths to the user; call again with confirm:true to move the node and its relation documents to _trash',
      }
    }
    if (incident.length > 0 && args.cascade !== true) {
      throw new KnowledgeToolError('invalid', 'this node still has edges; pass cascade:true to remove them as well', node.id)
    }
    const caller = await requireGraphJsonWrite(host, store, nodeActual)
    const nodes = state.manifest.nodes.filter(item => item.id !== node.id)
    const edges = state.manifest.edges.filter(item => item.from !== node.id && item.to !== node.id)
    const commit = await commitManifest(host, store, caller, nextManifestRecord(state, nodes, edges), state.manifestText)
    const moves: Array<{ from: string; to: string }> = []
    try {
      if (!node.missing) {
        moves.push(await moveToTrash(host, store, caller, nodeActual, 'nodes', trashName))
      }
      for (const edge of incident) {
        if (edge.docPath === undefined || edge.missing) continue
        moves.push(await moveToTrash(
          host, store, caller, joinRel(store.actualBase, edge.docPath), 'links', `${tag}-${edge.id}.md`,
        ))
      }
      requireValidGraph(await validateGraphStore(host, store), store)
    } catch (error) {
      await restoreTrashMoves(host, caller, moves)
      await rollbackManifest(host, store, caller, commit)
      throw error
    }
    await host.refreshView().catch(() => undefined)
    const audit = await recordAudit(host, caller, {
      action: 'delete', relPath: nodeView, toRelPath: joinRel(store.viewStorePath, '_trash/nodes'),
      tool: 'kg_del', graphId: graph.path, topicId: node.id, intent: 'move-to-trash',
      diffSummary: 'moved node to _trash' + (incident.length > 0 ? ' with ' + String(incident.length) + ' edge(s)' : ''),
      outcome: 'applied',
    })
    return { ok: true, ...summary, movedToTrash: true, audit }
  }

  const edge = target.edge!
  const docView = edge.docPath === undefined ? graph.path : joinRel(store.viewBase, edge.docPath)
  const tag = stamp()
  const trashName = `${tag}-${edge.id}.md`
  const summary = {
    action: 'del', kind: 'edge', format: 'graph-json', graph: graph.path, id: edge.id,
    from: edge.from, to: edge.to, doc: edge.docPath,
    docTo: edge.docPath === undefined || edge.missing
      ? undefined
      : joinRel(store.viewStorePath, `_trash/links/${trashName}`),
  }
  if (args.confirm !== true) {
    return {
      ok: true, draft: true, ...summary,
      next: 'show these paths to the user; call again with confirm:true to move the relation document to _trash',
    }
  }
  const caller = await requireGraphJsonWrite(
    host,
    store,
    edge.docPath === undefined ? undefined : joinRel(store.actualBase, edge.docPath),
  )
  const edges = state.manifest.edges.filter(item => item.id !== edge.id)
  const commit = await commitManifest(host, store, caller, nextManifestRecord(state, state.manifest.nodes, edges), state.manifestText)
  const moves: Array<{ from: string; to: string }> = []
  try {
    if (edge.docPath !== undefined && !edge.missing) {
      moves.push(await moveToTrash(host, store, caller, joinRel(store.actualBase, edge.docPath), 'links', trashName))
    }
    requireValidGraph(await validateGraphStore(host, store), store)
  } catch (error) {
    await restoreTrashMoves(host, caller, moves)
    await rollbackManifest(host, store, caller, commit)
    throw error
  }
  await host.refreshView().catch(() => undefined)
  const audit = await recordAudit(host, caller, {
    action: 'delete', relPath: docView, toRelPath: joinRel(store.viewStorePath, '_trash/links'),
    tool: 'kg_del', graphId: graph.path, topicId: edge.id, intent: 'move-to-trash',
    diffSummary: 'removed edge ' + edge.id + ' from graph.json', outcome: 'applied',
  })
  return { ok: true, ...summary, movedToTrash: true, audit }
}

/**
 * Build the four graph tools.
 *
 * @param host - the Host seam, shared with the knowledge file tools.
 * @returns Tool definitions for the disclosure coordinator.
 */
export const createKnowledgeGraphTools = (host: KnowledgeGraphToolHost) => [
  defineTool({
    name: 'kg_add',
    description: 'Add one graph item and WRITE the knowledge tree. Call without confirm:true first to receive the exact draft; '
      + 'show that draft to the user; call again with confirm:true only after they approve. '
      + 'kind=graph creates a new graph-json graph: it writes .graphs/<id>/graph.json under the caller\'s writable scope '
      + '(scope=personal by default, or department/global when the caller may write there). Use it when kg_add/kg_get say '
      + 'no readable graph matches; the draft is the exact manifest, and confirm:true creates the graph so later kg_add calls resolve it. '
      + 'Legacy folder graphs: kind=topic creates a visible folder + index.md card; kind=link creates a hidden .kg/links document. '
      + 'Graph-json graphs (format=graph-json, stored under .graphs/<id>/graph.json): kind=node creates the node document at "path" '
      + 'with an id/type/title/authority/internalizable/origin/reviewStatus/tags/sourceRefs front matter block and appends {id,path} '
      + 'to graph.json; kind=edge appends {id,from,to,type} and, when a body or edge attributes are given, writes .graphs/<id>/links/<id>.md. '
      + 'Duplicate ids and unknown edge endpoints are refused. "graph" is the graph path or name; "kind" is topic/link for a legacy graph, '
      + 'node/edge for a graph-json graph, or graph to create one. '
      + 'The computed overview graph 总图 is read-only: kind=edge on graph="总图" (or "__overview__") writes a cross-graph link to '
      + 'personal/.graphs/__overview__/links.json using fromGraph/toGraph (graph ids) plus from/to (node ids); kind=node there is refused.',
    parameters: {
      graph: { type: 'string', description: 'Graph path or name, e.g. personal/知识图谱/工作轨迹 or personal/.graphs/procurement; 总图 for a cross-graph edge. Not required for kind=graph.' },
      kind: { type: 'string', required: true, description: 'topic | link (legacy graph), node | edge (graph-json graph, or edge on 总图), or graph (create a graph-json graph).' },
      id: { type: 'string', description: 'Item id (topic/node/edge) or new graph id: lowercase letters, digits or hyphens.' },
      name: { type: 'string', description: 'Display name of the new graph (kind=graph).' },
      scope: { type: 'string', description: 'Create scope for kind=graph: personal (default) | department | global, or an explicit department/<chain> path.' },
      description: { type: 'string', description: 'Optional graph description (kind=graph).' },
      title: { type: 'string', description: 'Node title, edge document title, legacy topic card title, or graph name fallback (kind=graph).' },
      path: { type: 'string', description: 'Node document path relative to the graph scope, e.g. 制度/采购制度.md (graph-json node kind).' },
      type: { type: 'string', description: 'Node type (policy|fact|procedure|case|skill|decision|topic; default fact) or edge relation type (graph-json and overview cross-graph edges).' },
      authority: { type: 'string', description: 'canonical | advisory | redline; default advisory (graph-json and overview edges).' },
      internalizable: { type: 'boolean', description: 'Whether personal internalization is allowed; default true (graph-json and overview edges).' },
      origin: { type: 'string', description: 'human | ai | mixed; default human (graph-json and overview edges).' },
      reviewStatus: { type: 'string', description: 'draft | reviewed | approved; default draft (graph-json and overview edges).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Node, edge or graph tags (graph-json and overview edges).' },
      sourceRefs: { type: 'array', items: { type: 'string' }, description: 'Node or edge source references (graph-json and overview edges).' },
      from: { type: 'string', description: 'Source node id of the edge (kind=edge).' },
      to: { type: 'string', description: 'Target node id of the edge (kind=edge).' },
      fromGraph: { type: 'string', description: 'Source graph id for a 总图 cross-graph edge (kind=edge, graph=总图).' },
      toGraph: { type: 'string', description: 'Target graph id for a 总图 cross-graph edge (kind=edge, graph=总图).' },
      domain: { type: 'string', description: 'Legacy topic card domain; default default.' },
      status: { type: 'string', description: 'Legacy topic card status: active | paused | done.' },
      depth: { type: 'number', description: 'Legacy topic card depth, 1..5.' },
      summary: { type: 'string', description: 'Legacy topic card summary.' },
      body: { type: 'string', description: 'Free Markdown body (node document body or relation-document body).' },
      a: { type: 'string', description: 'Legacy relation first topic id (link kind).' },
      b: { type: 'string', description: 'Legacy relation second topic id (link kind).' },
      label: { type: 'string', description: 'Legacy relation label.' },
      confirm: { type: 'boolean', description: 'Write only when true; omitted/false returns the draft.' },
    },
    output: jsonOutput,
    execute: async (args: {
      graph?: string; kind: string; id?: string; title?: string; domain?: string; status?: string;
      depth?: number; summary?: string; body?: string; a?: string; b?: string; label?: string; confirm?: boolean;
      path?: string; type?: string; authority?: string; internalizable?: boolean; origin?: string;
      reviewStatus?: string; tags?: string[]; sourceRefs?: string[]; from?: string; to?: string;
      fromGraph?: string; toGraph?: string;
      name?: string; scope?: string; description?: string;
    }) => run(async () => {
      const kind = (args.kind ?? '').trim()
      if (kind === 'graph') return createGraphJson(host, args)
      const graphValue = (args.graph ?? '').trim()
      if (graphValue === '') {
        throw new KnowledgeToolError('invalid', 'graph is required unless kind is "graph"; create one first with ' + graphCreateHint())
      }
      const graphs = await host.listGraphs()
      const graph = requireGraph(graphs, graphValue)
      if (isOverviewGraph(graph)) {
        if (args.kind === 'edge') return addOverviewEdge(host, graphs, graph, args)
        if (args.kind === 'node') throw overviewReadOnly('node')
        throw new KnowledgeToolError(
          'invalid',
          'the overview graph 总图 is computed and read-only; only kind:"edge" (a cross-graph link) can be added there',
        )
      }
      const store = graphJsonStore(graph)
      if (store !== undefined) return addToGraphJson(host, graph, store, args)
      const actualGraph = actualGraphPath(graph)
      if (!await host.canWrite(actualGraph)) {
        throw new KnowledgeToolError('forbidden', 'write access is required for this graph', graph.path)
      }
      const caller = await host.resolveCaller()

      if (args.kind === 'topic') {
        const id = (args.id ?? '').trim()
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(id)) {
          throw new KnowledgeToolError('invalid', 'id must be 1-40 lowercase letters, digits or hyphens')
        }
        if (graph.topics.some(topic => topic.id === id)) {
          throw new KnowledgeToolError('exists', 'a topic with this id already exists', id)
        }
        const title = (args.title ?? '').trim()
        if (title === '') throw new KnowledgeToolError('invalid', 'title is required')
        const status = requireStatus(args.status) ?? 'active'
        const depth = requireDepth(args.depth) ?? 1
        const domain = (args.domain ?? 'default').trim() || 'default'
        const summary = args.summary ?? ''
        const body = args.body ?? ''
        const content = renderCard({ id, title, status, depth, domain, summary, body })
        if (args.confirm !== true) {
          return { ok: true, draft: true, action: 'add', kind: 'topic', graph: graph.path, id, content,
            next: 'show this draft to the user; call again with confirm:true to write it' }
        }
        const folder = title.replace(/[/\\]/gu, '-').trim() || id
        const actualFolder = actualGraph + '/' + folder
        if (await host.statEntry(actualFolder) !== undefined) {
          throw new KnowledgeToolError('exists', 'a folder already exists at ' + folder, folder)
        }
        await host.createEntry(actualFolder, { directory: true })
        await host.createEntry(actualFolder + '/index.md', { directory: false, content })
        await host.refreshView().catch(() => undefined)
        const audit = await recordAudit(host, caller, {
          action: 'create', relPath: graph.path + '/' + folder, tool: 'kg_add', graphId: graph.path,
          topicId: id, intent: 'new topic', diffSummary: 'created topic card ' + title,
          outcome: 'applied',
        })
        return { ok: true, action: 'add', kind: 'topic', graph: graph.path, path: graph.path + '/' + folder, audit }
      }

      if (args.kind === 'link') {
        const a = (args.a ?? '').trim()
        const b = (args.b ?? '').trim()
        if (a === '' || b === '' || a === b) throw new KnowledgeToolError('invalid', 'a and b must name two different topics')
        if (!graph.topics.some(topic => topic.id === a) || !graph.topics.some(topic => topic.id === b)) {
          throw new KnowledgeToolError('not-found', 'both endpoints must be existing topics in this graph')
        }
        const key = a < b ? a + '--' + b : b + '--' + a
        const content = renderLink({ a, b, ...(args.label === undefined ? {} : { label: args.label }), body: args.body ?? '' })
        if (args.confirm !== true) {
          return { ok: true, draft: true, action: 'add', kind: 'link', graph: graph.path, key, content,
            next: 'show this draft to the user; call again with confirm:true to write it' }
        }
        const linksDir = actualGraph + '/.kg/links'
        await host.createEntry(linksDir, { directory: true }).catch(() => undefined)
        await host.createEntry(linksDir + '/' + key + '.md', { directory: false, content })
        await host.refreshView().catch(() => undefined)
        const audit = await recordAudit(host, caller, {
          action: 'create', relPath: graph.path + '/.kg/links/' + key + '.md', tool: 'kg_add', graphId: graph.path,
          intent: 'new relation', diffSummary: 'linked ' + a + ' ↔ ' + b, outcome: 'applied',
        })
        return { ok: true, action: 'add', kind: 'link', graph: graph.path, path: '.kg/links/' + key + '.md', audit }
      }

      throw new KnowledgeToolError('invalid', 'kind must be topic or link')
    }),
  }),

  defineTool({
    name: 'kg_get',
    description: 'Read the knowledge graph. Without graph/id it returns the overview of every readable graph; '
      + 'when none exists the answer names the kg_add kind=graph call that creates one. '
      + 'With graph and no id it lists that graph\'s topics, nodes and relations. With graph+id it returns one item: a legacy topic card, '
      + 'or a graph-json node/edge with its id/title/type/authority/origin/reviewStatus/tags/sourceRefs, path and missing flag. '
      + 'Graph-json graphs are read from .graphs/<id>/graph.json plus the referenced node documents\' front matter. '
      + 'graph="总图" (or "__overview__") returns the computed aggregate: readable graph summaries, nodes namespaced '
      + '"<graphId>:<nodeId>" and edges with remapped endpoints, including cross-graph links. Read-only; never writes.',
    parameters: {
      graph: { type: 'string', description: 'Graph path or name; 总图 defaults to personal, or pass global/__overview__ / department/__overview__ / personal/__overview__. Omit for the catalogue.' },
      id: { type: 'string', description: 'Topic, node or edge id. Omit to list the graph.' },
    },
    output: jsonOutput,
    execute: async (args: { graph?: string; id?: string }) => run(async () => {
      const graphs = await host.listGraphs()
      if (args.graph === undefined || args.graph.trim() === '') {
        // The synthesized overviews are views over the other graphs; counting them
        // in the totals would double every node. Advertise them as separate rows.
        const readable = graphs.filter(graph => !isOverviewGraph(graph))
        const overviews = graphs.filter(isOverviewGraph)
        const personalOverview = overviews.find(graph => graph.scope === 'personal')
        return {
          ok: true,
          overview: true,
          totals: {
            graphs: readable.length,
            topics: readable.reduce((sum, graph) => sum + graph.topics.length, 0),
            relations: readable.reduce((sum, graph) => sum + graph.links.length, 0),
          },
          graphs: readable.map(graph => ({
            id: graph.id,
            name: graph.name,
            scope: graph.scope,
            group: graph.group,
            path: graph.path,
            format: (graph as GraphNodeWithFormat).format ?? 'legacy',
            counts: graph.counts,
            topics: graph.topics.map(topic => topicSummary(graph, topic)),
          })),
          ...(overviews.length === 0
            ? {}
            : {
                overviewGraphs: overviews.map(overview => ({
                  id: overview.id,
                  name: overview.name,
                  scope: overview.scope,
                  computed: true,
                  readOnly: true,
                  counts: overview.counts,
                })),
                ...(personalOverview === undefined
                  ? {}
                  : {
                      overviewGraph: {
                        id: personalOverview.id,
                        name: personalOverview.name,
                        scope: personalOverview.scope,
                        computed: true,
                        readOnly: true,
                        counts: personalOverview.counts,
                        next: 'call kg_get {"graph":"总图"} for personal, or global/__overview__ / department/__overview__',
                      },
                    }),
              }),
          ...(readable.length === 0
            ? { next: 'no graph exists yet; create one with ' + graphCreateHint() + ' (draft, then confirm:true)' }
            : {}),
        }
      }
      const graph = requireGraph(graphs, args.graph)
      if (isOverviewGraph(graph)) return getOverview(host, graphs, graph)
      const store = graphJsonStore(graph)
      if (store !== undefined) return getFromGraphJson(host, graph, store, args.id)
      if (args.id === undefined || args.id.trim() === '') {
        return {
          ok: true,
          graph: {
            id: graph.id, name: graph.name, scope: graph.scope, group: graph.group,
            path: graph.path, counts: graph.counts,
            topics: graph.topics.map(topic => topicSummary(graph, topic)),
            relations: graph.links.map(link => ({ a: link.a, b: link.b, label: link.label, updated: link.updated, body: link.body })),
          },
        }
      }
      const topic = requireTopic(graph, args.id)
      const relations = graph.links.filter(link => link.a === topic.id || link.b === topic.id)
      return {
        ok: true,
        graph: { id: graph.id, name: graph.name, path: graph.path },
        topic: {
          id: topic.id, title: topic.title, status: topic.status, depth: topic.depth,
          domain: topic.domain, tags: topic.tags, summary: topic.summary, body: topic.body,
          path: topicViewPath(graph, topic),
          documents: topic.documents.map(document => ({ title: document.title, file: document.file, path: document.path, date: document.date, summary: document.summary })),
          relations: relations.map(link => ({
            other: link.a === topic.id ? link.b : link.a,
            label: link.label, updated: link.updated, body: link.body,
          })),
        },
      }
    }),
  }),

  defineTool({
    name: 'kg_set',
    description: 'Change one graph item. Call without confirm:true first to receive a before/after draft; show it to the user; call again with confirm:true only after approval. '
      + 'Legacy topic cards: status, depth, title, domain, summary and/or body. '
      + 'Graph-json graphs: kind=node updates the node front matter (title/type/authority/internalizable/origin/reviewStatus/tags/sourceRefs) without touching its body; '
      + 'kind=edge updates type/authority/internalizable and the optional relation-document body. Only the named fields change.',
    parameters: {
      graph: { type: 'string', required: true, description: 'Graph path or name.' },
      id: { type: 'string', required: true, description: 'Topic, node or edge id to edit.' },
      kind: { type: 'string', description: 'node or edge (graph-json graphs); omit when the id is unambiguous.' },
      title: { type: 'string' }, domain: { type: 'string' }, status: { type: 'string' }, depth: { type: 'number' },
      summary: { type: 'string' }, body: { type: 'string' },
      type: { type: 'string', description: 'New node type or edge relation type (graph-json only).' },
      authority: { type: 'string', description: 'canonical | advisory | redline (graph-json only).' },
      internalizable: { type: 'boolean', description: 'Whether personal internalization is allowed (graph-json only).' },
      origin: { type: 'string', description: 'human | ai | mixed (graph-json node only).' },
      reviewStatus: { type: 'string', description: 'draft | reviewed | approved (graph-json node only).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Node tags (graph-json node only).' },
      sourceRefs: { type: 'array', items: { type: 'string' }, description: 'Node source references (graph-json node only).' },
      confirm: { type: 'boolean', description: 'Write only when true; omitted/false returns the draft.' },
    },
    output: jsonOutput,
    execute: async (args: {
      graph: string; id: string; kind?: string; title?: string; domain?: string; status?: string; depth?: number;
      summary?: string; body?: string; type?: string; authority?: string; internalizable?: boolean;
      origin?: string; reviewStatus?: string; tags?: string[]; sourceRefs?: string[]; confirm?: boolean;
    }) => run(async () => {
      const graphs = await host.listGraphs()
      const graph = requireGraph(graphs, args.graph)
      if (isOverviewGraph(graph)) throw overviewReadOnly('item')
      const store = graphJsonStore(graph)
      if (store !== undefined) return setOnGraphJson(host, graph, store, args)
      const topic = requireTopic(graph, args.id)
      const actualGraph = actualGraphPath(graph)
      if (!await host.canWrite(actualGraph)) {
        throw new KnowledgeToolError('forbidden', 'write access is required for this graph', graph.path)
      }
      const caller = await host.resolveCaller()
      const viewPath = topicViewPath(graph, topic)
      const text = await host.readText(viewPath + '/index.md')
      const parsed = parseGraphFrontMatter(text)
      const before = {
        title: parsed.meta.title ?? topic.title,
        status: parsed.meta.status ?? topic.status,
        depth: parsed.meta.depth ?? String(topic.depth),
        domain: parsed.meta.domain ?? topic.domain ?? 'default',
        summary: firstSummary(parsed.body),
        body: bodyAfterSummary(parsed.body),
      }
      const status = requireStatus(args.status) ?? before.status
      const depth = requireDepth(args.depth) ?? Number(before.depth)
      const title = (args.title ?? before.title).trim()
      const domain = (args.domain ?? before.domain).trim() || 'default'
      const summary = args.summary ?? before.summary
      const body = args.body ?? before.body
      const content = renderCard({ id: topic.id, title, status, depth, domain, summary, body, updated: today() })
      const after = { title, status, depth, domain, summary, body }
      if (args.confirm !== true) {
        return { ok: true, draft: true, action: 'set', graph: graph.path, id: topic.id, before, after, content,
          next: 'show this draft to the user; call again with confirm:true to write it' }
      }
      await host.overwriteFile(topicActualPath(graph, topic) + '/index.md', content)
      await host.refreshView().catch(() => undefined)
      const audit = await recordAudit(host, caller, {
        action: 'edit', relPath: viewPath, tool: 'kg_set', graphId: graph.path, topicId: topic.id,
        intent: 'update card', diffSummary: 'updated ' + Object.keys(after).filter(key => before[key as keyof typeof before] !== after[key as keyof typeof after]).join(', '),
        outcome: 'applied',
      })
      return { ok: true, action: 'set', graph: graph.path, id: topic.id, after, audit }
    }),
  }),

  defineTool({
    name: 'kg_del',
    description: 'Move one graph item to _trash (never delete). Call without confirm:true first to receive the affected paths; show them to the user; call again with confirm:true only after approval. '
      + 'Legacy graphs: moves the topic folder; relation documents touching it block the move unless force:true. '
      + 'Graph-json graphs: removes the node/edge from graph.json and moves the node body (or relation document) under .graphs/<id>/_trash/; a node with edges needs cascade:true. '
      + 'The audit trail records the actor, time, graph, item and both paths.',
    parameters: {
      graph: { type: 'string', required: true, description: 'Graph path or name.' },
      id: { type: 'string', required: true, description: 'Topic, node or edge id to move to _trash.' },
      kind: { type: 'string', description: 'node or edge (graph-json graphs); omit when the id is unambiguous.' },
      cascade: { type: 'boolean', description: 'Graph-json node kind: also remove its edges and move their documents to _trash.' },
      force: { type: 'boolean', description: 'Legacy graphs: also move relation documents that reference the topic.' },
      confirm: { type: 'boolean', description: 'Write only when true; omitted/false returns the draft.' },
    },
    output: jsonOutput,
    execute: async (args: { graph: string; id: string; kind?: string; cascade?: boolean; force?: boolean; confirm?: boolean }) => run(async () => {
      const graphs = await host.listGraphs()
      const graph = requireGraph(graphs, args.graph)
      if (isOverviewGraph(graph)) return deleteOverviewEdge(host, graph, args)
      const store = graphJsonStore(graph)
      if (store !== undefined) return deleteFromGraphJson(host, graph, store, args)
      const topic = requireTopic(graph, args.id)
      const actualGraph = actualGraphPath(graph)
      if (!await host.canWrite(actualGraph)) {
        throw new KnowledgeToolError('forbidden', 'write access is required for this graph', graph.path)
      }
      const caller = await host.resolveCaller()
      const relations: KnowledgeGraphLink[] = graph.links.filter(link => link.a === topic.id || link.b === topic.id)
      const stampValue = new Date().toISOString().replace(/[:.]/gu, '-')
      const topicFrom = topicActualPath(graph, topic)
      const topicTo = actualGraph + '/_trash/topics/' + stampValue + '-' + topic.folder
      const relationMoves = relations
        .filter(link => link.file !== undefined)
        .map(link => ({ from: actualGraph + '/.kg/links/' + link.file!, to: actualGraph + '/_trash/links/' + stampValue + '-' + link.file! }))
      const viewTopicTo = graph.path + '/_trash/topics/' + stampValue + '-' + topic.folder
      const summary = { action: 'del', graph: graph.path, id: topic.id, topicFrom: topicViewPath(graph, topic), topicTo: viewTopicTo, relations: relations.map(link => ({ a: link.a, b: link.b, file: link.file })) }
      if (args.confirm !== true) {
        return { ok: true, draft: true, ...summary, needsForce: relations.length > 0 && args.force !== true,
          next: relations.length > 0 && args.force !== true
            ? 'show the affected relations to the user; call again with confirm:true and force:true to move everything to _trash'
            : 'show these paths to the user; call again with confirm:true to move them to _trash' }
      }
      if (relations.length > 0 && args.force !== true) {
        throw new KnowledgeToolError('invalid', 'this topic still has relations; pass force:true to move them to _trash as well')
      }
      await host.createEntry(actualGraph + '/_trash/topics', { directory: true }).catch(() => undefined)
      await host.moveEntry(topicFrom, topicTo, caller)
      if (relationMoves.length > 0) {
        await host.createEntry(actualGraph + '/_trash/links', { directory: true }).catch(() => undefined)
        for (const move of relationMoves) await host.moveEntry(move.from, move.to, caller)
      }
      await host.refreshView().catch(() => undefined)
      const audit = await recordAudit(host, caller, {
        action: 'delete', relPath: topicViewPath(graph, topic), toRelPath: viewTopicTo,
        tool: 'kg_del', graphId: graph.path, topicId: topic.id, intent: 'move-to-trash',
        diffSummary: 'moved topic to _trash' + (relationMoves.length > 0 ? ' with ' + relationMoves.length + ' relation(s)' : ''),
        outcome: 'applied',
      })
      return { ok: true, ...summary, movedToTrash: true, audit }
    }),
  }),
]
