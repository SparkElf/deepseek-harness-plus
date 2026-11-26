/**
 * Migration of the legacy knowledge-graph layout into the memory-graph layout.
 *
 * Legacy graphs are ordinary folders under a scope:
 *
 * ```text
 * <scope>/知识图谱/<graph>/<topic>/index.md   # topic card
 * <scope>/知识图谱/<graph>/<topic>/<doc>.md   # documents (nested folders allowed)
 * <scope>/知识图谱/<graph>/.kg/links/*.md     # hidden relations
 * ```
 *
 * The target model separates bodies from topology:
 *
 * ```text
 * <scope>/<classified>/<doc>.md               # one body, normal document tree
 * <scope>/.graphs/<graph>/graph.json          # manifest: topics + node/edge refs
 * <scope>/.graphs/<graph>/links/<edge>.md     # optional relation bodies
 * ```
 *
 * The planner is read-only. `applyMigration` performs the planned file
 * operations, but only after the plan has no error-level issue: duplicate
 * bodies are never deleted while a broken edge, a duplicate id, or an unsafe
 * path is still unresolved. Every write is a temporary file followed by a
 * rename; independent documents are moved, never copied.
 *
 * Dedupe order matches the contract: frontmatter `id`, then sha256 of the
 * whole document, then the classified path (`<topic>/<doc>`), then the title.
 * A title/path/id match whose body differs is a conflict for human review and
 * is left in the legacy tree untouched.
 *
 * @module @sparkelf/dsh-knowledge-base/graph-migration
 */

import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

/** Folder whose children are legacy graphs. */
export const KNOWLEDGE_GRAPH_FOLDER = '知识图谱'

/** Folder that receives legacy documents with no classified copy. */
export const GRAPH_DOCUMENT_FOLDER = '图谱文档'

/** Hidden folder that holds the new manifests and relation documents. */
export const GRAPH_STORE_FOLDER = '.graphs'

/** Where the emptied legacy graph shell is kept for one release cycle. */
export const GRAPH_ARCHIVE_FOLDER = '.archive/graphs'

const META_FOLDER = '.kg'
const LINKS_FOLDER = 'links'
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
const MAX_WALK_DEPTH = 16

/** Severity of one migration issue. Only `error` blocks `applyMigration`. */
export type MigrationIssueSeverity = 'error' | 'warning'

/** One problem found while planning a migration. */
export interface MigrationIssue {
  code: string
  message: string
  path?: string
  severity: MigrationIssueSeverity
}

/** Options accepted by both the planner and the applier. */
export interface MigrationOptions {
  /** The scope root that contains `知识图谱/` and the classified document tree. */
  scopeRoot: string
  /** Planning is always read-only; the flag is carried into the report. */
  dryRun: boolean
  /** Fixed timestamp for generated manifests; defaults to now. */
  now?: string
  /**
   * Overwrite an existing `.graphs/<graph>/graph.json`.
   *
   * Only the manifest is replaced. Existing node bodies and link documents are
   * never overwritten; a differing target is an error-level issue instead.
   */
  force?: boolean
  /** Manifest scope override, e.g. `department:data-platform`. */
  scope?: string
  /** Manifest visibility override. */
  visibility?: 'private' | 'department' | 'global'
}

/** The report rendered by `renderMigrationReport` and printed by the CLI. */
export interface MigrationReport {
  graphs: Array<{ graphId: string; name: string; topics: number; documents: number; links: number }>
  matched: number
  independent: number
  conflicts: number
  brokenEdges: number
  plannedWrites: string[]
  /** Independent-document moves (legacy graph -> 图谱文档/). */
  plannedMoves: Array<{ from: string; to: string }>
  /** Legacy graph shells that will be moved into `.archive/graphs/`. */
  plannedArchives?: Array<{ from: string; to: string }>
  plannedDeletes: string[]
  issues: MigrationIssue[]
  /** True for a plan, false once `applyMigration` has run. */
  dryRun?: boolean
  /** True when every planned operation completed. */
  applied?: boolean
}

interface FrontMatter {
  meta: Record<string, string>
  body: string
}

/** One markdown document read from the scope, before its role is known. */
interface DocRecord {
  relPath: string
  text: string
  body: string
  bodyTrimmed: string
  fileHash: string
  title: string
  id?: string
}

/** A legacy graph document: a normal document plus its topic coordinates. */
interface LegacyDoc extends DocRecord {
  topicFolder: string
  relativeToTopic: string
}

/** A legacy relation document under `<graph>/.kg/links/`. */
interface LegacyLink {
  relPath: string
  text: string
  meta: Record<string, string>
  body: string
}

interface TopicScan {
  folder: string
  relPath: string
  indexPath?: string
  indexText?: string
  docs: LegacyDoc[]
}

interface LegacyGraph {
  graphId: string
  name: string
  relPath: string
  topics: TopicScan[]
  links: LegacyLink[]
  /** Files this migrator does not move: they keep the shell from being archived. */
  unhandled: string[]
}

interface CandidateIndex {
  byId: Map<string, DocRecord[]>
  byHash: Map<string, DocRecord[]>
  byTitle: Map<string, DocRecord[]>
  byRelPath: Map<string, DocRecord>
}

/** A canonical document that can satisfy a legacy document's dedupe lookup. */
interface MatchRef {
  relPath: string
  bodyTrimmed: string
  fileHash: string
  title: string
  id?: string
  nodeId?: string
}

interface PlannedNode {
  id: string
  path: string
  title: string
}

interface PlannedEdge {
  id: string
  from: string
  to: string
  type: string
  docPath: string
  body: string
}

interface GraphPlan {
  graphId: string
  name: string
  topics: Array<{ id: string; title: string; description?: string }>
  nodes: PlannedNode[]
  edges: PlannedEdge[]
  manifest?: { path: string; content: string }
  linkWrites: Array<{ path: string; content: string }>
  /** Independent-document moves only; the archive move is kept separately. */
  moves: Array<{ from: string; to: string }>
  deletes: Array<{ path: string; reason: string }>
  archive?: { from: string; to: string }
  issues: MigrationIssue[]
  counts: { topics: number; documents: number; links: number }
  error: boolean
  matched: number
  independent: number
  conflicts: number
  brokenEdges: number
}

interface BuiltMigration {
  report: MigrationReport
  plans: GraphPlan[]
}

interface DocResolution {
  kind: 'matched' | 'independent'
  node: PlannedNode
  conflict?: never
}

interface DocConflict {
  kind: 'conflict'
  code: string
  message: string
  severity: MigrationIssueSeverity
}

type Resolution = DocResolution | DocConflict

// ---------------------------------------------------------------------------
// Small filesystem and text helpers
// ---------------------------------------------------------------------------

const tempCounter = { value: 0 }

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/gu, '\n')
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/** Split a document into its simple hand-written frontmatter and body. */
function parseFrontMatter(text: string): FrontMatter {
  const normalized = normalizeNewlines(text)
  if (!normalized.startsWith('---\n')) return { meta: {}, body: normalized }
  const end = normalized.indexOf('\n---\n', 4)
  if (end < 0) return { meta: {}, body: normalized }
  const meta: Record<string, string> = {}
  for (const rawLine of normalized.slice(4, end).split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    meta[line.slice(0, colon).trim()] = unquote(line.slice(colon + 1))
  }
  return { meta, body: normalized.slice(end + 5) }
}

function firstHeading(body: string): string | undefined {
  for (const line of body.split('\n')) {
    if (line.startsWith('# ')) return line.slice(2).trim()
  }
  return undefined
}

function stripExtension(name: string): string {
  return name.replace(/\.[^./]+$/u, '')
}

function lastSegment(relPath: string): string {
  const parts = relPath.split('/')
  return parts[parts.length - 1] ?? relPath
}

function documentTitle(meta: Record<string, string>, body: string, relPath: string): string {
  const explicit = (meta.title ?? '').trim()
  if (explicit !== '') return explicit
  return firstHeading(body) ?? stripExtension(lastSegment(relPath))
}

/** First paragraph after the H1, used as a topic description. */
function firstParagraph(body: string): string {
  const lines = normalizeNewlines(body).split('\n')
  let index = lines.findIndex(line => line.startsWith('# '))
  if (index < 0) index = 0
  else index += 1
  while (index < lines.length && (lines[index] ?? '').trim() === '') index += 1
  const collected: string[] = []
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '' || line.startsWith('#')) break
    collected.push(line.trim())
    index += 1
  }
  return collected.join(' ')
}

function makeDocRecord(relPath: string, text: string): DocRecord {
  const normalized = normalizeNewlines(text)
  const { meta, body } = parseFrontMatter(normalized)
  const id = (meta.id ?? '').trim()
  return {
    relPath,
    text: normalized,
    body,
    bodyTrimmed: body.trim(),
    fileHash: sha256(normalized),
    title: documentTitle(meta, body, relPath),
    ...(id === '' ? {} : { id }),
  }
}

function titleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/gu, ' ')
}

function isSafeRelative(relPath: string): boolean {
  if (relPath === '' || relPath.startsWith('/') || relPath.includes('\0') || relPath.includes('\\')) return false
  return relPath.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/** Resolve a `/`-relative path under a root, refusing escapes. */
function absoluteUnder(scopeRoot: string, relPath: string): string | undefined {
  if (!isSafeRelative(relPath)) return undefined
  const absolute = join(scopeRoot, ...relPath.split('/'))
  const rel = relative(scopeRoot, absolute)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || rel.includes('\0')) return undefined
  return absolute
}

async function listEntries(directory: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  } catch {
    return []
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES) return undefined
    const text = await readFile(path, 'utf8')
    return text.includes('\0') ? undefined : text
  } catch {
    return undefined
  }
}

function pushToMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const current = map.get(key)
  if (current === undefined) map.set(key, [value])
  else current.push(value)
}

function uniqueBy<T>(values: T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const value of values) {
    const key = keyOf(value)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

// ---------------------------------------------------------------------------
// Candidate documents (the classified tree)
// ---------------------------------------------------------------------------

/**
 * Read every markdown document that could already hold the same body.
 *
 * `知识图谱/` is the migration source and is skipped. Hidden folders (which
 * includes `.graphs/` and `.archive/`) and `_trash/` are skipped as well. The
 * generated `图谱文档/` tree is deliberately included: after a partial run the
 * moved copy must be recognised instead of moved twice.
 */
async function scanCandidates(scopeRoot: string): Promise<DocRecord[]> {
  const docs: DocRecord[] = []
  const walk = async (directory: string, relDir: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH || docs.length > 20_000) return
    for (const entry of await listEntries(directory)) {
      if (entry.name.startsWith('.') || entry.name === '_trash' || entry.name === 'node_modules') continue
      const childRel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      if (relDir === '' && entry.name === KNOWLEDGE_GRAPH_FOLDER) continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), childRel, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      const text = await readTextFile(join(directory, entry.name))
      if (text === undefined) continue
      docs.push(makeDocRecord(childRel, text))
    }
  }
  await walk(scopeRoot, '', 0)
  return docs
}

function buildCandidateIndex(docs: DocRecord[]): CandidateIndex {
  const index: CandidateIndex = {
    byId: new Map(),
    byHash: new Map(),
    byTitle: new Map(),
    byRelPath: new Map(),
  }
  for (const doc of docs) {
    if (doc.id !== undefined) pushToMap(index.byId, doc.id, doc)
    pushToMap(index.byHash, doc.fileHash, doc)
    pushToMap(index.byTitle, titleKey(doc.title), doc)
    index.byRelPath.set(doc.relPath, doc)
  }
  return index
}

function candidateRef(doc: DocRecord): MatchRef {
  return {
    relPath: doc.relPath,
    bodyTrimmed: doc.bodyTrimmed,
    fileHash: doc.fileHash,
    title: doc.title,
    ...(doc.id === undefined ? {} : { id: doc.id }),
  }
}

// ---------------------------------------------------------------------------
// Legacy graph scanning
// ---------------------------------------------------------------------------

async function scanTopicDocuments(
  topicAbs: string,
  topicRel: string,
  docs: LegacyDoc[],
  unhandled: string[],
): Promise<void> {
  const walk = async (directory: string, relDir: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH) return
    for (const entry of await listEntries(directory)) {
      if (entry.name.startsWith('.') || entry.name === '_trash') continue
      const childRel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      const relPath = `${topicRel}/${childRel}`
      if (entry.isSymbolicLink()) {
        unhandled.push(relPath)
        continue
      }
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), childRel, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!entry.name.toLowerCase().endsWith('.md')) {
        unhandled.push(relPath)
        continue
      }
      // Only the topic's OWN index.md is its card. A nested index.md is a
      // normal document, exactly as the legacy scanner treats it.
      if (depth === 0 && childRel === 'index.md') continue
      const text = await readTextFile(join(directory, entry.name))
      if (text === undefined) {
        unhandled.push(relPath)
        continue
      }
      docs.push({
        ...makeDocRecord(relPath, text),
        topicFolder: lastSegment(topicRel),
        relativeToTopic: childRel,
      })
    }
  }
  await walk(topicAbs, '', 0)
}

async function scanLegacyLinks(graphAbs: string, graphRel: string, unhandled: string[]): Promise<LegacyLink[]> {
  const links: LegacyLink[] = []
  const linksAbs = join(graphAbs, META_FOLDER, LINKS_FOLDER)
  const entries = await listEntries(linksAbs)
  if (entries.length === 0) {
    // No links directory is normal. Other visible files under `.kg/` are not
    // understood by this migrator and must keep the shell from archiving.
    for (const entry of await listEntries(join(graphAbs, META_FOLDER))) {
      if (entry.name.startsWith('.') || entry.name === LINKS_FOLDER) continue
      if (entry.isFile()) unhandled.push(`${graphRel}/${META_FOLDER}/${entry.name}`)
    }
    return links
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const relPath = `${graphRel}/${META_FOLDER}/${LINKS_FOLDER}/${entry.name}`
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
      unhandled.push(relPath)
      continue
    }
    const text = await readTextFile(join(linksAbs, entry.name))
    if (text === undefined) {
      unhandled.push(relPath)
      continue
    }
    const { meta, body } = parseFrontMatter(text)
    links.push({ relPath, text: normalizeNewlines(text), meta, body })
  }
  return links
}

async function scanLegacyGraph(scopeRoot: string, graphId: string): Promise<LegacyGraph> {
  const graphRel = `${KNOWLEDGE_GRAPH_FOLDER}/${graphId}`
  const graphAbs = join(scopeRoot, KNOWLEDGE_GRAPH_FOLDER, graphId)
  const graph: LegacyGraph = {
    graphId,
    name: graphId,
    relPath: graphRel,
    topics: [],
    links: [],
    unhandled: [],
  }
  for (const entry of await listEntries(graphAbs)) {
    if (entry.name === META_FOLDER) continue
    if (entry.name.startsWith('.') || entry.name === '_trash') continue
    const childRel = `${graphRel}/${entry.name}`
    if (entry.isSymbolicLink()) {
      graph.unhandled.push(childRel)
      continue
    }
    if (!entry.isDirectory()) {
      if (entry.isFile()) graph.unhandled.push(childRel)
      continue
    }
    const topic: TopicScan = {
      folder: entry.name,
      relPath: `${graphRel}/${entry.name}`,
      docs: [],
    }
    const indexPath = join(graphAbs, entry.name, 'index.md')
    const indexText = await readTextFile(indexPath)
    if (indexText !== undefined) {
      topic.indexPath = `${topic.relPath}/index.md`
      topic.indexText = indexText
    }
    await scanTopicDocuments(join(graphAbs, entry.name), topic.relPath, topic.docs, graph.unhandled)
    graph.topics.push(topic)
  }
  graph.links = await scanLegacyLinks(graphAbs, graphRel, graph.unhandled)
  return graph
}

// ---------------------------------------------------------------------------
// Planning one graph
// ---------------------------------------------------------------------------

function mergeRefs(kept: MatchRef[], candidates: DocRecord[] | undefined): MatchRef[] {
  const refs: MatchRef[] = [...kept]
  for (const doc of candidates ?? []) refs.push(candidateRef(doc))
  return uniqueBy(refs, ref => ref.relPath)
}

function sameBody(a: string, b: string): boolean {
  return a === b
}

function issue(
  code: string,
  message: string,
  path: string | undefined,
  severity: MigrationIssueSeverity,
): MigrationIssue {
  return { code, message, severity, ...(path === undefined ? {} : { path }) }
}

function assignNodeId(preferred: string | undefined, relPath: string, used: Set<string>): string {
  const explicit = (preferred ?? '').trim()
  if (explicit !== '') {
    if (!used.has(explicit)) return explicit
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${explicit}-${suffix}`
      if (!used.has(candidate)) return candidate
    }
  }
  const stem = stripExtension(lastSegment(relPath))
    .replace(/[\u0000-\u001f\\/:*?"<>|]/gu, '-')
    .replace(/\s+/gu, '-')
    .trim()
  const base = stem === '' ? 'node' : `node-${stem}`
  if (!used.has(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

function sanitizeEdgeId(value: string, fallbackSeed: string): string {
  const cleaned = value
    .trim()
    .replace(/[\u0000-\u001f\\/:*?"<>|]/gu, '-')
    .replace(/^\.+$/u, '')
  if (cleaned !== '') return cleaned
  return `edge-${sha256(fallbackSeed).slice(0, 12)}`
}

function legacyLinkId(link: LegacyLink): string {
  const stem = stripExtension(lastSegment(link.relPath))
  const explicit = (link.meta.id ?? '').trim()
  return sanitizeEdgeId(explicit === '' ? stem : explicit, link.relPath)
}

function renderEdgeDocument(edge: PlannedEdge): string {
  const lines = [
    '---',
    `id: ${edge.id}`,
    `from: ${edge.from}`,
    `to: ${edge.to}`,
    `type: ${edge.type}`,
    'authority: advisory',
    'internalizable: true',
    'origin: human',
    'reviewStatus: draft',
    '---',
    '',
  ]
  const body = edge.body.trim()
  if (body !== '') lines.push(body)
  return `${lines.join('\n')}\n`
}

interface GraphBuildContext {
  scopeRoot: string
  graph: LegacyGraph
  options: MigrationOptions
  now: string
  candidates: CandidateIndex
  candidatePaths: Set<string>
}

interface GraphBuildState {
  graphId: string
  issues: MigrationIssue[]
  nodes: PlannedNode[]
  nodesById: Map<string, PlannedNode>
  nodesByPath: Map<string, PlannedNode>
  usedNodeIds: Set<string>
  keptById: Map<string, MatchRef[]>
  keptByHash: Map<string, MatchRef[]>
  keptByTitle: Map<string, MatchRef[]>
  keptByRelPath: Map<string, MatchRef>
  matched: number
  independent: number
  conflicts: number
}

function registerKept(state: GraphBuildState, node: PlannedNode, source: {
  relPath: string
  bodyTrimmed: string
  fileHash: string
  title: string
  id?: string
}): void {
  if (state.keptByRelPath.has(source.relPath)) return
  const ref: MatchRef = {
    relPath: source.relPath,
    bodyTrimmed: source.bodyTrimmed,
    fileHash: source.fileHash,
    title: source.title,
    nodeId: node.id,
    ...(source.id === undefined ? {} : { id: source.id }),
  }
  state.keptByRelPath.set(ref.relPath, ref)
  if (ref.id !== undefined) pushToMap(state.keptById, ref.id, ref)
  pushToMap(state.keptByHash, ref.fileHash, ref)
  pushToMap(state.keptByTitle, titleKey(ref.title), ref)
}

function ensureCandidateNode(
  state: GraphBuildState,
  ref: MatchRef,
  legacy: LegacyDoc,
): PlannedNode {
  const existing = state.nodesByPath.get(ref.relPath)
  if (existing !== undefined) return existing
  const id = assignNodeId(ref.id ?? legacy.id, ref.relPath, state.usedNodeIds)
  const node: PlannedNode = { id, path: ref.relPath, title: ref.title }
  state.usedNodeIds.add(id)
  state.nodesById.set(id, node)
  state.nodesByPath.set(node.path, node)
  state.nodes.push(node)
  registerKept(state, node, ref)
  return node
}

function candidateNodeFor(
  state: GraphBuildState,
  ref: MatchRef,
  legacy: LegacyDoc,
): PlannedNode {
  if (ref.nodeId !== undefined) {
    const node = state.nodesById.get(ref.nodeId)
    if (node !== undefined) return node
  }
  return ensureCandidateNode(state, ref, legacy)
}

function resolveLegacyDoc(
  context: GraphBuildContext,
  state: GraphBuildState,
  doc: LegacyDoc,
): Resolution {
  // 1. Frontmatter id wins over every content signal.
  if (doc.id !== undefined) {
    const refs = mergeRefs(state.keptById.get(doc.id) ?? [], context.candidates.byId.get(doc.id))
    if (refs.length === 1) {
      const ref = refs[0] as MatchRef
      if (sameBody(ref.bodyTrimmed, doc.bodyTrimmed)) {
        state.matched += 1
        return { kind: 'matched', node: candidateNodeFor(state, ref, doc) }
      }
      state.conflicts += 1
      return {
        kind: 'conflict',
        code: 'id-conflict',
        severity: 'warning',
        message: `id ${doc.id} already exists at ${ref.relPath}, but the body differs; left for manual review`,
      }
    }
    if (refs.length > 1) {
      const equal = refs.filter(ref => sameBody(ref.bodyTrimmed, doc.bodyTrimmed))
      if (equal.length === 1) {
        state.matched += 1
        return { kind: 'matched', node: candidateNodeFor(state, equal[0] as MatchRef, doc) }
      }
      state.conflicts += 1
      return {
        kind: 'conflict',
        code: 'ambiguous-id-match',
        severity: 'warning',
        message: `id ${doc.id} matches ${refs.length} documents (${refs.map(ref => ref.relPath).join(', ')}); left for manual review`,
      }
    }
  }

  // 2. Exact document hash (byte-identical copy, frontmatter included).
  const hashRefs = mergeRefs(state.keptByHash.get(doc.fileHash) ?? [], context.candidates.byHash.get(doc.fileHash))
  if (hashRefs.length > 0) {
    const ref = hashRefs[0] as MatchRef
    state.matched += 1
    return { kind: 'matched', node: candidateNodeFor(state, ref, doc) }
  }

  // 3. The classified path that mirrors `<topic>/<doc>`.
  const mirroredPath = `${doc.topicFolder}/${doc.relativeToTopic}`
  const pathRef = state.keptByRelPath.get(mirroredPath) ?? (
    context.candidates.byRelPath.get(mirroredPath) === undefined
      ? undefined
      : candidateRef(context.candidates.byRelPath.get(mirroredPath) as DocRecord)
  )
  if (pathRef !== undefined) {
    if (sameBody(pathRef.bodyTrimmed, doc.bodyTrimmed)) {
      state.matched += 1
      return { kind: 'matched', node: candidateNodeFor(state, pathRef, doc) }
    }
    state.conflicts += 1
    return {
      kind: 'conflict',
      code: 'path-conflict',
      severity: 'warning',
      message: `${mirroredPath} exists with a different body; left for manual review`,
    }
  }

  // 4. Title. Same title, different body is never merged automatically.
  const titleRefs = mergeRefs(
    state.keptByTitle.get(titleKey(doc.title)) ?? [],
    context.candidates.byTitle.get(titleKey(doc.title)),
  )
  if (titleRefs.length > 0) {
    const equal = titleRefs.filter(ref => sameBody(ref.bodyTrimmed, doc.bodyTrimmed))
    if (equal.length === 1) {
      state.matched += 1
      return { kind: 'matched', node: candidateNodeFor(state, equal[0] as MatchRef, doc) }
    }
    state.conflicts += 1
    return {
      kind: 'conflict',
      code: titleRefs.length > 1 ? 'ambiguous-title-match' : 'title-conflict',
      severity: 'warning',
      message: equal.length > 1
        ? `title "${doc.title}" has ${equal.length} identical bodies; left for manual review`
        : `title "${doc.title}" exists at ${titleRefs.map(ref => ref.relPath).join(', ')} with a different body; left for manual review`,
    }
  }

  // 5. No match: keep the body as an independent graph document.
  const destination = `${GRAPH_DOCUMENT_FOLDER}/${context.graph.graphId}/${doc.topicFolder}/${doc.relativeToTopic}`
  if (context.candidatePaths.has(destination)) {
    state.conflicts += 1
    return {
      kind: 'conflict',
      code: 'move-target-exists',
      severity: 'error',
      message: `move target ${destination} already exists with an unreadable or different document; left for manual review`,
    }
  }
  if (!isSafeRelative(destination)) {
    state.conflicts += 1
    state.issues.push(issue('path-escape', `cannot move ${doc.relPath}: destination escapes the scope`, doc.relPath, 'error'))
    return { kind: 'conflict', code: 'path-escape', severity: 'error', message: 'unsafe destination path' }
  }
  const id = assignNodeId(doc.id, destination, state.usedNodeIds)
  const node: PlannedNode = { id, path: destination, title: doc.title }
  state.usedNodeIds.add(id)
  state.nodesById.set(id, node)
  state.nodesByPath.set(node.path, node)
  state.nodes.push(node)
  registerKept(state, node, {
    relPath: destination,
    bodyTrimmed: doc.bodyTrimmed,
    fileHash: doc.fileHash,
    title: doc.title,
    ...(doc.id === undefined ? {} : { id: doc.id }),
  })
  state.independent += 1
  return { kind: 'independent', node }
}

async function buildGraphPlan(context: GraphBuildContext): Promise<GraphPlan> {
  const { graph, options, scopeRoot } = context
  const state: GraphBuildState = {
    graphId: graph.graphId,
    issues: [],
    nodes: [],
    nodesById: new Map(),
    nodesByPath: new Map(),
    usedNodeIds: new Set(),
    keptById: new Map(),
    keptByHash: new Map(),
    keptByTitle: new Map(),
    keptByRelPath: new Map(),
    matched: 0,
    independent: 0,
    conflicts: 0,
  }
  for (const relPath of graph.unhandled) {
    state.issues.push(issue(
      'unmigrated-file',
      'not a markdown document this migrator understands; left in place, so the legacy shell is not archived',
      relPath,
      'warning',
    ))
  }
  const moves: Array<{ from: string; to: string }> = []
  const deletes: Array<{ path: string; reason: string }> = []
  const leftovers = new Set<string>(graph.unhandled)
  const topics: GraphPlan['topics'] = []
  const topicToNode = new Map<string, string>()
  const usedTopicIds = new Set<string>()
  const consumedIndexPaths = new Set<string>()

  for (const topic of graph.topics) {
    let topicId = topic.folder
    let topicTitle = topic.folder
    let description: string | undefined
    if (topic.indexText !== undefined) {
      const { meta, body } = parseFrontMatter(topic.indexText)
      const explicitId = (meta.id ?? '').trim()
      if (explicitId !== '') topicId = explicitId
      const explicitTitle = (meta.title ?? '').trim()
      if (explicitTitle !== '') topicTitle = explicitTitle
      const summary = firstParagraph(body)
      if (summary !== '') description = summary
    }
    if (usedTopicIds.has(topicId)) {
      state.issues.push(issue('duplicate-topic-id', `topic id ${topicId} appears more than once`, topic.relPath, 'error'))
    }
    usedTopicIds.add(topicId)
    topics.push({ id: topicId, title: topicTitle, ...(description === undefined ? {} : { description }) })

    let representative: string | undefined
    for (const doc of topic.docs) {
      const resolution = resolveLegacyDoc(context, state, doc)
      if (resolution.kind === 'conflict') {
        leftovers.add(doc.relPath)
        state.issues.push(issue(resolution.code, resolution.message, doc.relPath, resolution.severity))
        continue
      }
      if (resolution.kind === 'independent') {
        moves.push({ from: doc.relPath, to: resolution.node.path })
      } else {
        deletes.push({ path: doc.relPath, reason: 'exact duplicate; body kept elsewhere' })
      }
      if (representative === undefined) representative = resolution.node.id
    }
    if (topic.indexPath !== undefined && topic.indexText !== undefined) {
      // A topic card is a real document, not just metadata: its body can be
      // several kilobytes. Move it into the normal document tree as a topic
      // node so `topics[]` only ever carries the short description and no card
      // body is lost. The node id is the topic id, so legacy edges that point
      // at topics keep their exact topic-to-topic meaning.
      const card = makeDocRecord(topic.indexPath, topic.indexText)
      const destination = `${GRAPH_DOCUMENT_FOLDER}/${graph.graphId}/${topic.folder}/index.md`
      if (!isSafeRelative(destination) || context.candidatePaths.has(destination)) {
        state.issues.push(issue(
          'move-target-exists',
          `topic card target ${destination} already exists or is unsafe; relation endpoints stay unresolved`,
          topic.indexPath,
          'error',
        ))
      } else {
        const id = assignNodeId(topicId, destination, state.usedNodeIds)
        const node: PlannedNode = { id, path: destination, title: topicTitle }
        state.usedNodeIds.add(id)
        state.nodesById.set(id, node)
        state.nodesByPath.set(node.path, node)
        state.nodes.push(node)
        registerKept(state, node, {
          relPath: destination,
          bodyTrimmed: card.bodyTrimmed,
          fileHash: card.fileHash,
          title: card.title,
          id: topicId,
        })
        moves.push({ from: topic.indexPath, to: destination })
        consumedIndexPaths.add(topic.indexPath)
        if (representative === undefined) representative = node.id
      }
    }
    if (representative !== undefined) topicToNode.set(topicId, representative)
  }

  // Relation documents. A legacy edge connects TOPICS; the new manifest
  // connects nodes. Each topic endpoint resolves to the topic's first
  // document, so one legacy relation stays one edge with resolvable ends.
  const edges: PlannedEdge[] = []
  const linkWrites: Array<{ path: string; content: string }> = []
  const usedEdgeIds = new Set<string>()
  const nodeIds = new Set(state.nodes.map(node => node.id))
  for (const link of graph.links) {
    const fallback = stripExtension(lastSegment(link.relPath)).split('--')
    const a = (link.meta.a ?? fallback[0] ?? '').trim()
    const b = (link.meta.b ?? fallback[1] ?? '').trim()
    const from = nodeIds.has(a) ? a : topicToNode.get(a)
    const to = nodeIds.has(b) ? b : topicToNode.get(b)
    if (a === '' || b === '' || a === b || from === undefined || to === undefined) {
      state.issues.push(issue(
        'broken-edge',
        `edge ${a || '?'} -> ${b || '?'} cannot be resolved to graph nodes`,
        link.relPath,
        'error',
      ))
      leftovers.add(link.relPath)
      continue
    }
    const edgeId = legacyLinkId(link)
    if (usedEdgeIds.has(edgeId)) {
      state.issues.push(issue('duplicate-edge-id', `edge id ${edgeId} appears more than once`, link.relPath, 'error'))
      leftovers.add(link.relPath)
      continue
    }
    const type = (link.meta.type ?? '').trim() === '' ? 'related_to' : (link.meta.type ?? '').trim()
    const body = link.body.trim() === '' ? (link.meta.label ?? '').trim() : link.body.trim()
    const edge: PlannedEdge = {
      id: edgeId,
      from,
      to,
      type,
      docPath: `${GRAPH_STORE_FOLDER}/${graph.graphId}/links/${edgeId}.md`,
      body,
    }
    const content = renderEdgeDocument(edge)
    const targetAbs = absoluteUnder(scopeRoot, edge.docPath)
    if (targetAbs === undefined) {
      state.issues.push(issue('path-escape', `link target ${edge.docPath} escapes the scope`, link.relPath, 'error'))
      leftovers.add(link.relPath)
      continue
    }
    if (await pathExists(targetAbs)) {
      const existing = await readTextFile(targetAbs)
      if (existing === undefined || normalizeNewlines(existing) !== content) {
        state.issues.push(issue(
          'link-target-exists',
          `link document ${edge.docPath} exists with different content; not overwritten`,
          link.relPath,
          'error',
        ))
        leftovers.add(link.relPath)
        continue
      }
    } else {
      linkWrites.push({ path: edge.docPath, content })
    }
    usedEdgeIds.add(edgeId)
    edges.push(edge)
    deletes.push({ path: link.relPath, reason: 'relation moved to .graphs links/' })
  }
  const manifestRel = `${GRAPH_STORE_FOLDER}/${graph.graphId}/graph.json`
  const manifestAbs = absoluteUnder(scopeRoot, manifestRel)
  const manifestExists = manifestAbs !== undefined && (await isFile(manifestAbs))
  const operationsEnabled = !manifestExists || options.force === true
  if (manifestExists && options.force !== true) {
    state.issues.push(issue(
      'manifest-exists',
      `${manifestRel} already exists; use --force to overwrite the manifest`,
      manifestRel,
      'warning',
    ))
  }

  let manifest: GraphPlan['manifest']
  if (operationsEnabled && topics.length > 0) {
    const defaults = inferScopeDefaults(scopeRoot)
    const manifestObject = {
      schemaVersion: 1,
      id: graph.graphId,
      name: graph.name,
      scope: options.scope ?? defaults.scope,
      version: 1,
      status: 'draft' as const,
      createdAt: context.now,
      updatedAt: context.now,
      tags: [] as string[],
      visibility: options.visibility ?? defaults.visibility,
      topics,
      nodes: state.nodes.map(node => ({ id: node.id, path: node.path })),
      edges: edges.map(edge => ({ id: edge.id, from: edge.from, to: edge.to, type: edge.type, doc: edge.docPath })),
    }
    manifest = {
      path: manifestRel,
      content: `${JSON.stringify(manifestObject, null, 2)}\n`,
    }
    for (const topic of graph.topics) {
      if (topic.indexPath !== undefined && !consumedIndexPaths.has(topic.indexPath)) {
        deletes.push({ path: topic.indexPath, reason: 'topic card converted to graph.json topics[]' })
      }
    }
  } else if (manifestExists && options.force !== true) {
    // Already migrated: report the inventory, but do not touch anything.
    moves.length = 0
    deletes.length = 0
    linkWrites.length = 0
    leftovers.clear()
  }

  const plan: GraphPlan = {
    graphId: graph.graphId,
    name: graph.name,
    topics,
    nodes: state.nodes,
    edges,
    ...(manifest === undefined ? {} : { manifest }),
    linkWrites,
    moves,
    deletes,
    issues: state.issues,
    counts: { topics: topics.length, documents: state.nodes.length, links: edges.length },
    error: false,
    matched: state.matched,
    independent: state.independent,
    conflicts: state.conflicts,
    brokenEdges: 0,
  }
  plan.brokenEdges = plan.issues.filter(entry => entry.code === 'broken-edge').length

  if (operationsEnabled && leftovers.size === 0) {
    const archiveRel = `${GRAPH_ARCHIVE_FOLDER}/${graph.graphId}`
    const archiveAbs = absoluteUnder(scopeRoot, archiveRel)
    if (archiveAbs === undefined) {
      plan.issues.push(issue('path-escape', `archive target ${archiveRel} escapes the scope`, graph.relPath, 'error'))
    } else if (await pathExists(archiveAbs)) {
      plan.issues.push(issue('archive-exists', `${archiveRel} already exists; legacy shell left in place`, graph.relPath, 'warning'))
    } else {
      plan.archive = { from: graph.relPath, to: archiveRel }
    }
  }
  if (graph.topics.length === 0 && graph.links.length === 0 && state.nodes.length === 0) {
    plan.issues.push(issue('empty-graph', 'legacy graph has no topics, documents or links; empty shell is archived', graph.relPath, 'warning'))
  }

  await validatePlan(scopeRoot, plan)
  plan.error = plan.issues.some(entry => entry.severity === 'error')
  return plan
}

/** Check that every manifest reference will be resolvable after apply. */
async function validatePlan(scopeRoot: string, plan: GraphPlan): Promise<void> {
  if (plan.manifest !== undefined && !isSafeRelative(plan.manifest.path)) {
    plan.issues.push(issue('path-escape', `manifest path ${plan.manifest.path} is unsafe`, plan.manifest.path, 'error'))
  }
  const ids = new Set<string>()
  const paths = new Set<string>()
  const destinations = new Set(plan.moves.map(move => move.to))
  for (const node of plan.nodes) {
    if (!isSafeRelative(node.path)) {
      plan.issues.push(issue('path-escape', `node path ${node.path} is unsafe`, node.path, 'error'))
      continue
    }
    if (ids.has(node.id)) {
      plan.issues.push(issue('duplicate-node-id', `node id ${node.id} appears more than once`, node.path, 'error'))
    }
    ids.add(node.id)
    if (paths.has(node.path)) {
      plan.issues.push(issue('duplicate-node-path', `node path ${node.path} is referenced twice`, node.path, 'error'))
    }
    paths.add(node.path)
    if (destinations.has(node.path)) continue
    const absolute = absoluteUnder(scopeRoot, node.path)
    if (absolute === undefined || !(await isFile(absolute))) {
      plan.issues.push(issue('missing-node', `node body ${node.path} does not exist`, node.path, 'error'))
    }
  }
  const edgeIds = new Set<string>()
  for (const edge of plan.edges) {
    if (edgeIds.has(edge.id)) {
      plan.issues.push(issue('duplicate-edge-id', `edge id ${edge.id} appears more than once`, edge.docPath, 'error'))
    }
    edgeIds.add(edge.id)
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      plan.issues.push(issue('unknown-endpoint', `edge ${edge.id} points at a missing node`, edge.docPath, 'error'))
    }
  }
  const topicIds = new Set<string>()
  for (const topic of plan.topics) {
    if (topicIds.has(topic.id)) {
      plan.issues.push(issue('duplicate-topic-id', `topic id ${topic.id} appears more than once`, undefined, 'error'))
    }
    topicIds.add(topic.id)
  }
}

function inferScopeDefaults(scopeRoot: string): { scope: string; visibility: 'private' | 'department' | 'global' } {
  const parts = toPosix(scopeRoot).split('/').filter(part => part !== '')
  const last = parts[parts.length - 1] ?? ''
  if (last === 'global') return { scope: 'global', visibility: 'global' }
  if (last === 'personal') return { scope: 'personal:unknown', visibility: 'private' }
  if (last === 'department') return { scope: 'department:unknown', visibility: 'department' }
  const personal = parts.lastIndexOf('personal')
  if (personal >= 0 && parts[personal + 1] !== undefined) {
    return { scope: `personal:${parts[personal + 1] as string}`, visibility: 'private' }
  }
  const department = parts.lastIndexOf('department')
  if (department >= 0) {
    const chain = parts.slice(department + 1).join('/')
    if (chain !== '') return { scope: `department:${chain}`, visibility: 'department' }
  }
  return { scope: 'global', visibility: 'global' }
}

// ---------------------------------------------------------------------------
// Public API: plan, apply, render
// ---------------------------------------------------------------------------

async function buildMigration(options: MigrationOptions): Promise<BuiltMigration> {
  const scopeRoot = options.scopeRoot
  const now = options.now ?? new Date().toISOString()
  const graphRoot = join(scopeRoot, KNOWLEDGE_GRAPH_FOLDER)
  const graphDirs = (await listEntries(graphRoot)).filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
  const candidateDocs = await scanCandidates(scopeRoot)
  const candidates = buildCandidateIndex(candidateDocs)
  const candidatePaths = new Set(candidateDocs.map(doc => doc.relPath))
  const plans: GraphPlan[] = []
  for (const entry of graphDirs) {
    if (entry.name === '_trash' || entry.name.startsWith('.')) continue
    const graph = await scanLegacyGraph(scopeRoot, entry.name)
    plans.push(await buildGraphPlan({ scopeRoot, graph, options, now, candidates, candidatePaths }))
  }
  plans.sort((a, b) => a.graphId.localeCompare(b.graphId, 'zh-Hans-CN'))

  const report: MigrationReport = {
    graphs: plans.map(plan => ({
      graphId: plan.graphId,
      name: plan.name,
      topics: plan.counts.topics,
      documents: plan.counts.documents,
      links: plan.counts.links,
    })),
    matched: plans.reduce((sum, plan) => sum + plan.matched, 0),
    independent: plans.reduce((sum, plan) => sum + plan.independent, 0),
    conflicts: plans.reduce((sum, plan) => sum + plan.conflicts, 0),
    brokenEdges: plans.reduce((sum, plan) => sum + plan.brokenEdges, 0),
    plannedWrites: uniqueSorted(plans.flatMap(plan => [
      ...(plan.manifest === undefined ? [] : [plan.manifest.path]),
      ...plan.linkWrites.map(write => write.path),
    ])),
    plannedMoves: plans.flatMap(plan => plan.moves)
      .map(move => ({ from: move.from, to: move.to }))
      .sort((a, b) => a.from.localeCompare(b.from, 'zh-Hans-CN')),
    plannedArchives: plans.flatMap(plan => plan.archive === undefined ? [] : [plan.archive])
      .map(move => ({ from: move.from, to: move.to }))
      .sort((a, b) => a.from.localeCompare(b.from, 'zh-Hans-CN')),
    plannedDeletes: uniqueSorted(plans.flatMap(plan => plan.deletes.map(del => del.path))),
    issues: plans.flatMap(plan => plan.issues),
    dryRun: options.dryRun,
    applied: false,
  }
  return { report, plans }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

/** Plan a migration without writing anything. */
export async function planMigration(options: MigrationOptions): Promise<MigrationReport> {
  return (await buildMigration(options)).report
}

/** Whether a report contains an issue that blocks `applyMigration`. */
export function migrationReportHasErrors(report: MigrationReport): boolean {
  return report.issues.some(entry => entry.severity === 'error')
}

/**
 * Execute a previously planned migration.
 *
 * The report is recomputed before anything is written so the caller cannot
 * apply a stale plan. Any error-level issue aborts the whole run before the
 * first file operation. Writes are atomic; independent documents are moved;
 * duplicate bodies and old topic cards are deleted only after the manifest has
 * been written and every node body is present on disk.
 */
export async function applyMigration(options: MigrationOptions & { report: MigrationReport }): Promise<MigrationReport> {
  if (migrationReportHasErrors(options.report)) {
    return { ...options.report, dryRun: false, applied: false }
  }
  const built = await buildMigration({ ...options, dryRun: false })
  const report = built.report
  if (migrationReportHasErrors(report)) {
    return { ...report, dryRun: false, applied: false }
  }
  for (const plan of built.plans) {
    try {
      await executePlan(options.scopeRoot, plan)
    } catch (error) {
      report.issues.push(issue(
        'apply-failed',
        `graph ${plan.graphId}: ${error instanceof Error ? error.message : String(error)}`,
        plan.graphId,
        'error',
      ))
      return { ...report, dryRun: false, applied: false }
    }
  }
  return { ...report, dryRun: false, applied: true }
}

async function executePlan(scopeRoot: string, plan: GraphPlan): Promise<void> {
  for (const move of plan.moves) {
    await moveFile(scopeRoot, move.from, move.to)
  }
  for (const write of plan.linkWrites) {
    await atomicWrite(scopeRoot, write.path, write.content)
  }
  // The duplicate deletion gate: every node body must exist before any legacy
  // file is removed.
  for (const node of plan.nodes) {
    const absolute = absoluteUnder(scopeRoot, node.path)
    if (absolute === undefined || !(await isFile(absolute))) {
      throw new Error(`node body ${node.path} is missing after moves; refusing to delete duplicates`)
    }
  }
  if (plan.manifest !== undefined) {
    await atomicWrite(scopeRoot, plan.manifest.path, plan.manifest.content)
  }
  for (const deletion of plan.deletes) {
    const absolute = absoluteUnder(scopeRoot, deletion.path)
    if (absolute === undefined) throw new Error(`refusing to delete unsafe path ${deletion.path}`)
    await rm(absolute, { force: true })
  }
  if (plan.archive !== undefined) {
    await moveDirectory(scopeRoot, plan.archive.from, plan.archive.to)
  }
}

async function atomicWrite(scopeRoot: string, relPath: string, content: string): Promise<void> {
  const absolute = absoluteUnder(scopeRoot, relPath)
  if (absolute === undefined) throw new Error(`refusing to write unsafe path ${relPath}`)
  await mkdir(dirname(absolute), { recursive: true })
  tempCounter.value += 1
  const temporary = `${absolute}.tmp-${process.pid}-${tempCounter.value}`
  await writeFile(temporary, content, 'utf8')
  try {
    await rename(temporary, absolute)
  } catch (error) {
    // Windows refuses to rename over an existing file; the destination has
    // already been fully written, so replacing it is still safe for a manifest.
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') {
      await rm(temporary, { force: true })
      throw error
    }
    await rm(absolute, { force: true })
    await rename(temporary, absolute)
  }
}

async function moveFile(scopeRoot: string, from: string, to: string): Promise<void> {
  const source = absoluteUnder(scopeRoot, from)
  const destination = absoluteUnder(scopeRoot, to)
  if (source === undefined || destination === undefined) throw new Error(`refusing to move unsafe path ${from} -> ${to}`)
  if (!(await pathExists(source))) {
    if (await pathExists(destination)) return
    throw new Error(`move source ${from} is missing`)
  }
  if (await pathExists(destination)) throw new Error(`move target ${to} already exists`)
  await mkdir(dirname(destination), { recursive: true })
  try {
    await rename(source, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await copyFile(source, destination)
    await rm(source, { force: true })
  }
}

async function moveDirectory(scopeRoot: string, from: string, to: string): Promise<void> {
  const source = absoluteUnder(scopeRoot, from)
  const destination = absoluteUnder(scopeRoot, to)
  if (source === undefined || destination === undefined) throw new Error(`refusing to move unsafe path ${from} -> ${to}`)
  if (!(await pathExists(source))) return
  if (await pathExists(destination)) throw new Error(`archive target ${to} already exists`)
  await mkdir(dirname(destination), { recursive: true })
  await rename(source, destination)
}

/** Render the report a human reads after a dry run or an apply. */
export function renderMigrationReport(report: MigrationReport): string {
  const errors = report.issues.filter(entry => entry.severity === 'error').length
  const warnings = report.issues.length - errors
  const mode = report.applied === true
    ? '已应用'
    : report.dryRun === false
      ? '未应用'
      : 'dry-run'
  const lines: string[] = []
  lines.push(`迁移报告（${mode}）`)
  lines.push('')
  lines.push(`图谱 ${report.graphs.length} 个`)
  for (const graph of report.graphs) {
    lines.push(`  ${graph.graphId}: topics=${graph.topics} documents=${graph.documents} links=${graph.links}`)
  }
  lines.push(`汇总 matched=${report.matched} independent=${report.independent} conflicts=${report.conflicts} brokenEdges=${report.brokenEdges} issues=${report.issues.length} (errors=${errors} warnings=${warnings})`)
  appendList(lines, '计划写入', report.plannedWrites)
  appendList(lines, '计划移动（独立文档）', report.plannedMoves.map(move => `${move.from} -> ${move.to}`))
  appendList(lines, '计划归档（旧图谱空壳）', (report.plannedArchives ?? []).map(move => `${move.from} -> ${move.to}`))
  appendList(lines, '计划删除', report.plannedDeletes)
  if (report.issues.length === 0) {
    lines.push('问题: 无')
  } else {
    lines.push(`问题 ${report.issues.length} 个`)
    for (const entry of report.issues) {
      const path = entry.path === undefined ? '' : ` ${entry.path}`
      lines.push(`  [${entry.severity}] ${entry.code}${path}: ${entry.message}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function appendList(lines: string[], label: string, values: string[]): void {
  if (values.length === 0) {
    lines.push(`${label}: 无`)
    return
  }
  lines.push(`${label} ${values.length} 项`)
  for (const value of values) lines.push(`  ${value}`)
}
