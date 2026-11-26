/**
 * Read-only scanner behind the knowledge-graph tab.
 *
 * The graph tab is a NAVIGATION layer over the knowledge tree, not a second
 * document store. A graph is an ordinary folder under a scope:
 *
 * ```text
 * <scope>/知识图谱/<graph>/
 *   <topic>/index.md          # the topic card, visible
 *   <topic>/<document>.md     # documents, visible
 *   <topic>/<folder>/<doc>.md # documents grouped below the topic, visible
 *   .kg/links/<a>--<b>.md     # relations, hidden from the file tree and search
 * ```
 *
 * Two rules shape this module:
 *
 * 1. **The permission answer is the Host's, one graph at a time.** DataOps resolves
 *    each graph folder; a graph it does not resolve is dropped before anything about
 *    it (name, topic, document) is returned. The browser never receives a full scope
 *    and filters it, because a denied name is still a disclosure.
 * 2. **The scanner is told where the scopes are.** The authoritative personal and
 *    department roots are resolved by the caller through `actualRelPathForView`, so
 *    this module never invents `personal/<uid>/…`. It only reads the directories it
 *    is handed and reports what is inside them.
 *
 * `.kg` is skipped by name everywhere a topic or document is listed. It is read on
 * purpose only for `<graph>/.kg/links/*.md`, which is exactly the structure the
 * design hides from the knowledge base.
 *
 * @module @sparkelf/dsh-knowledge-base/graph
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  KNOWLEDGE_GRAPH_META_FOLDER,
  KNOWLEDGE_GRAPH_TRASH_FOLDER,
  type KnowledgeGraphCaller,
  type KnowledgeGraphDocument,
  type KnowledgeGraphGroup,
  type KnowledgeGraphLink,
  type KnowledgeGraphNode,
  type KnowledgeGraphScope,
  type KnowledgeGraphScopeKey,
  type KnowledgeGraphTopic,
  type KnowledgeGraphTree,
} from './graphTypes.ts'

/** How much of a card or document is read for its summary and body. */
const GRAPH_TEXT_LIMIT = 256 * 1024

/** How many documents one topic reports; a card stack cannot show more. */
const MAX_TOPIC_DOCUMENTS = 200

/** How many graphs one scope reports. */
const MAX_SCOPE_GRAPHS = 200

/** How many topics one graph reports. */
const MAX_GRAPH_TOPICS = 200

/** A resolved scope root: where to scan, and how the tree labels the group. */
export interface KnowledgeGraphScopeRoot {
  /** Which canonical scope this root belongs to. */
  key: KnowledgeGraphScopeKey
  /** Authoritative path, relative to the knowledge root. */
  actualPath: string
  /** View-relative path the browser should show. */
  viewPath: string
  /** Department chain key; empty for global and personal. */
  groupKey: string
  /** Department display label; empty for global and personal. */
  groupLabel: string
}

/** What the scanner needs from the caller that owns the route. */
export interface KnowledgeGraphScanOptions {
  /** Authoritative knowledge root. */
  actualRoot: string
  /** Resolved scope roots, in display order the caller wants. */
  roots: KnowledgeGraphScopeRoot[]
  /** Caller identity, returned for tests and for a future owner label. */
  caller: KnowledgeGraphCaller
  /**
   * One permission question per graph folder.
   *
   * The route binds this to `canReadPath`, the same authority every other read
   * uses. A rejection is a denial (fail closed), not an empty directory.
   */
  canRead: (actualRelPath: string) => Promise<boolean>
}

/** One front-matter block and the body beneath it. */
interface FrontMatter {
  meta: Record<string, string>
  body: string
}

/**
 * Whether a relative path stays inside the root it will be joined to.
 *
 * The roots arrive from the Host's own resolver, so this is defence in depth
 * rather than the primary check: a `..` segment that slipped through a caller
 * would otherwise read outside the knowledge tree.
 */
function isSafeRelative(relPath: string): boolean {
  if (relPath === '' || relPath.startsWith('/') || relPath.includes('\0') || relPath.includes('\\')) return false
  return relPath.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/** Join a relative path onto a root, refusing an escape. */
function under(root: string, relPath: string): string | undefined {
  return isSafeRelative(relPath) ? join(root, relPath) : undefined
}

/**
 * Split a Markdown document into its simple YAML front matter and body.
 *
 * The graph format uses one `key: value` per line and optional bracket arrays;
 * a full YAML parser would be a dependency this package does not need. Unknown
 * lines are ignored rather than failing the whole card, so a hand-edited
 * `index.md` still renders.
 */
export function parseGraphFrontMatter(text: string): FrontMatter {
  const normalized = text.replace(/\r\n/gu, '\n')
  if (!normalized.startsWith('---\n')) return { meta: {}, body: normalized }
  const end = normalized.indexOf('\n---\n', 4)
  if (end < 0) return { meta: {}, body: normalized }
  const meta: Record<string, string> = {}
  for (const rawLine of normalized.slice(4, end).split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  return { meta, body: normalized.slice(end + 5) }
}

/** Read a bracketed or comma-separated list value from front matter. */
export function parseGraphList(value: string | undefined): string[] {
  if (value === undefined) return []
  const trimmed = value.trim()
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed
  return inner.split(',')
    .map(item => item.trim().replace(/^['"]|['"]$/gu, ''))
    .filter(item => item !== '')
}

/** The provenance values the graph badges understand, in contract order. */
const GRAPH_ORIGINS = ['human', 'ai', 'mixed'] as const
const GRAPH_REVIEW_STATUSES = ['draft', 'reviewed', 'approved'] as const
const GRAPH_AUTHORITIES = ['canonical', 'advisory', 'redline'] as const

/**
 * Read one optional enum front-matter value.
 *
 * Hand-edited cards are common, so an unknown value is ignored rather than
 * promoted into the payload; quotes are stripped because the scanner's YAML
 * subset does not unquote scalars.
 */
function graphChoice<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().replace(/^['"]|['"]$/gu, '').toLowerCase()
  return allowed.find(choice => choice === normalized)
}

/**
 * The optional provenance fields a topic card or one of its documents may carry.
 *
 * Missing or malformed values simply omit the field, which keeps every legacy
 * graph rendering exactly as before. The scanner must never fail a whole graph
 * because one document's front matter was hand-edited badly.
 */
function graphProvenance(
  meta: Record<string, string>,
): Pick<KnowledgeGraphTopic, 'origin' | 'reviewStatus' | 'authority'> {
  const origin = graphChoice(meta.origin, GRAPH_ORIGINS)
  const reviewStatus = graphChoice(meta.reviewStatus, GRAPH_REVIEW_STATUSES)
  const authority = graphChoice(meta.authority, GRAPH_AUTHORITIES)
  return {
    ...(origin === undefined ? {} : { origin }),
    ...(reviewStatus === undefined ? {} : { reviewStatus }),
    ...(authority === undefined ? {} : { authority }),
  }
}

/** First H1 of a Markdown body, without the marker. */
export function firstHeading(body: string): string | undefined {
  for (const line of body.split('\n')) {
    if (line.startsWith('# ')) return line.slice(2).trim()
  }
  return undefined
}

/**
 * The first paragraph after the H1: the text the card shows as its summary.
 *
 * Starting at the H1 rather than at the top is deliberate: the title is already
 * the card's heading, so repeating it as the first line of the summary would
 * render the same sentence twice.
 */
export function firstSummary(body: string): string {
  const lines = body.split('\n')
  let index = lines.findIndex(line => line.startsWith('# '))
  if (index < 0) index = 0
  else index += 1
  while (index < lines.length && lines[index]?.trim() === '') index += 1
  const collected: string[] = []
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '' || line.startsWith('#')) break
    collected.push(line.trim())
    index += 1
  }
  return collected.join(' ')
}

/** Remove the H1 and the summary paragraph, leaving the card's free body. */
export function bodyAfterSummary(body: string): string {
  const lines = body.split('\n')
  const heading = lines.findIndex(line => line.startsWith('# '))
  // A card without an H1 has no reliable summary boundary; keeping the body whole
  // is better than dropping the first paragraph the reader wrote.
  if (heading < 0) return body.trim()
  let start = heading + 1
  while (start < lines.length && lines[start]?.trim() === '') start += 1
  let end = start
  while (end < lines.length && (lines[end] ?? '').trim() !== '' && !(lines[end] ?? '').startsWith('#')) end += 1
  return [...lines.slice(0, heading), ...lines.slice(end)].join('\n').trim()
}

/** Read a text file, returning undefined for binary or oversized content. */
async function readGraphText(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > GRAPH_TEXT_LIMIT) return undefined
    const text = await readFile(path, 'utf8')
    return text.includes('\0') ? undefined : text
  } catch {
    return undefined
  }
}

/** ISO date (`YYYY-MM-DD`) of a file's modification instant. */
async function dateOf(path: string): Promise<string | undefined> {
  try {
    return (await stat(path)).mtime.toISOString().slice(0, 10)
  } catch {
    return undefined
  }
}

/** Visible child directories of a directory, in name order. */
async function visibleDirectories(path: string): Promise<Array<{ name: string; path: string }>> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => ({ name: entry.name, path: join(path, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  } catch {
    return []
  }
}

/** Visible files of a directory, in name order. */
async function visibleFiles(path: string): Promise<Array<{ name: string; path: string }>> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
      .map(entry => ({ name: entry.name, path: join(path, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  } catch {
    return []
  }
}

/** How deep below a topic folder the scanner follows nested document folders. */
const MAX_TOPIC_DOCUMENT_DEPTH = 8

/** One file below a topic folder, with its POSIX path relative to that folder. */
interface TopicDocumentFile {
  /** File name alone, used as the last-resort title. */
  readonly name: string
  /** Absolute path for reading its text. */
  readonly path: string
  /** Path relative to the topic folder, e.g. `岗位/张三.md`. */
  readonly relative: string
}

/**
 * Collect the visible documents below one topic folder, recursively.
 *
 * A topic's documents are not always written beside `index.md`: a `工作轨迹` topic
 * groups them into one folder per 岗位, and reading only the first level made those
 * documents invisible to `kg_get` and absent from the graph's document count. The
 * topic's own `index.md` is the card and is skipped; an `index.md` deeper in the tree
 * is a document like any other. Hidden entries are skipped at every level, which keeps
 * `.kg` and editor scratch files out.
 */
async function visibleTopicDocuments(topicPath: string): Promise<TopicDocumentFile[]> {
  const found: TopicDocumentFile[] = []
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_TOPIC_DOCUMENT_DEPTH || found.length >= MAX_TOPIC_DOCUMENTS) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    for (const entry of entries) {
      if (found.length >= MAX_TOPIC_DOCUMENTS) return
      if (entry.name.startsWith('.')) continue
      const absolute = join(directory, entry.name)
      const relative = prefix === '' ? entry.name : prefix + '/' + entry.name
      if (entry.isDirectory()) {
        await walk(absolute, relative, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      // Only the topic's OWN index.md is the card. A nested index.md belongs to the
      // document folder and is listed like every other file.
      if (relative === 'index.md') continue
      found.push({ name: entry.name, path: absolute, relative })
    }
  }
  await walk(topicPath, '', 0)
  return found.sort((a, b) => a.relative.localeCompare(b.relative, 'zh-Hans-CN'))
}

/** Join one view-relative parent with a child name, keeping POSIX separators. */
function viewJoin(parent: string, name: string): string {
  return parent === '' ? name : parent + '/' + name
}

/**
 * Read one topic folder into the canvas's topic shape.
 *
 * A missing `index.md` is not an error: the folder still names a topic, and the
 * card falls back to the folder name with an empty summary. That keeps a
 * half-written topic navigable instead of silently dropping it.
 */
export async function readGraphTopic(
  graphPath: string,
  viewGraphPath: string,
  folder: string,
): Promise<KnowledgeGraphTopic | undefined> {
  const topicPath = join(graphPath, folder)
  const viewTopicPath = viewJoin(viewGraphPath, folder)
  const indexPath = join(topicPath, 'index.md')
  const cardText = await readGraphText(indexPath)
  const card = cardText === undefined ? undefined : parseGraphFrontMatter(cardText)
  const body = card?.body ?? ''
  const meta = card?.meta ?? {}
  const documents: KnowledgeGraphDocument[] = []
  for (const file of await visibleTopicDocuments(topicPath)) {
    const text = await readGraphText(file.path)
    const documentBody = text === undefined ? undefined : parseGraphFrontMatter(text)
    const title = documentBody === undefined
      ? file.name.replace(/\.[^.]+$/u, '')
      : (firstHeading(documentBody.body) ?? file.name.replace(/\.[^.]+$/u, ''))
    const date = await dateOf(file.path)
    const document: KnowledgeGraphDocument = {
      title,
      file: file.relative,
      path: viewJoin(viewTopicPath, file.relative),
      ...(date === undefined ? {} : { date }),
      ...(documentBody === undefined ? {} : { summary: firstSummary(documentBody.body) }),
      ...graphProvenance(documentBody?.meta ?? {}),
    }
    documents.push(document)
  }
  const depthValue = Number.parseInt(meta.depth ?? '', 10)
  return {
    id: (meta.id ?? '').trim() === '' ? folder : (meta.id ?? '').trim(),
    title: (meta.title ?? '').trim() === '' ? folder : (meta.title ?? '').trim(),
    status: (meta.status ?? 'active').trim() === '' ? 'active' : (meta.status ?? 'active').trim(),
    depth: Number.isFinite(depthValue) ? Math.min(5, Math.max(1, depthValue)) : 1,
    ...((meta.domain ?? '').trim() === '' ? {} : { domain: (meta.domain ?? '').trim() }),
    tags: parseGraphList(meta.tags),
    summary: firstSummary(body),
    body: bodyAfterSummary(body),
    folder,
    path: viewTopicPath,
    documents,
    ...graphProvenance(meta),
  }
}

/**
 * Read `<graph>/.kg/links/*.md` into relation records.
 *
 * Links whose endpoints are not topics in this graph are dropped: the canvas
 * draws an edge between two cards, so an edge to a missing id would be an
 * invisible relation that still counted in the header. The relation FILE stays
 * on disk; this is a view decision, not a deletion.
 */
export async function readGraphLinks(graphPath: string, topicIds: ReadonlySet<string>): Promise<KnowledgeGraphLink[]> {
  const directory = join(graphPath, KNOWLEDGE_GRAPH_META_FOLDER, 'links')
  const links: KnowledgeGraphLink[] = []
  for (const file of await visibleFiles(directory)) {
    if (!file.name.endsWith('.md')) continue
    const text = await readGraphText(file.path)
    if (text === undefined) continue
    const { meta, body } = parseGraphFrontMatter(text)
    const fallback = file.name.replace(/\.md$/u, '').split('--')
    const a = (meta.a ?? fallback[0] ?? '').trim()
    const b = (meta.b ?? fallback[1] ?? '').trim()
    if (a === '' || b === '' || a === b) continue
    if (!topicIds.has(a) || !topicIds.has(b)) continue
    const label = (meta.label ?? meta.title ?? '').trim()
    links.push({
      a,
      b,
      ...(label === '' ? {} : { label }),
      ...((meta.updated ?? '').trim() === '' ? {} : { updated: (meta.updated ?? '').trim() }),
      body: firstSummary(body),
      file: file.name,
    })
  }
  return links
}

/**
 * Read one graph folder: its topics, documents and hidden relations.
 *
 * The permission question is asked by the caller BEFORE this runs, so this
 * function never sees a denied folder. It still treats unreadable paths as empty
 * rather than failing the whole graph: one removed folder should not blank the
 * canvas.
 */
export async function readGraph(
  actualRoot: string,
  root: KnowledgeGraphScopeRoot,
  folder: string,
  caller: KnowledgeGraphCaller,
): Promise<KnowledgeGraphNode | undefined> {
  const actualGraphRel = viewJoin(root.actualPath, folder)
  const actualGraphPath = under(actualRoot, actualGraphRel)
  if (actualGraphPath === undefined) return undefined
  const viewGraphPath = viewJoin(root.viewPath, folder)
  const topics: KnowledgeGraphTopic[] = []
  for (const directory of (await visibleDirectories(actualGraphPath)).slice(0, MAX_GRAPH_TOPICS)) {
    if (directory.name === KNOWLEDGE_GRAPH_META_FOLDER || directory.name === KNOWLEDGE_GRAPH_TRASH_FOLDER) continue
    const topic = await readGraphTopic(actualGraphPath, viewGraphPath, directory.name)
    if (topic !== undefined) topics.push(topic)
  }
  const topicIds = new Set(topics.map(topic => topic.id))
  const links = await readGraphLinks(actualGraphPath, topicIds)
  return {
    id: viewGraphPath,
    name: folder,
    scope: root.key,
    path: viewGraphPath,
    group: root.groupLabel,
    actualPath: actualGraphRel,
    topics,
    links,
    counts: {
      topics: topics.length,
      links: links.length,
      documents: topics.reduce((total, topic) => total + topic.documents.length, 0),
    },
  }
}

/** Order scopes the way the tree shows them. */
const SCOPE_ORDER: readonly KnowledgeGraphScopeKey[] = ['global', 'department', 'personal']

/**
 * Scan every resolved scope root and build the permission-filtered domain tree.
 *
 * The loop asks `canRead` once per graph folder. It never asks about `.kg`: the
 * metadata folder is read only after the graph itself was allowed, and its
 * contents are relations whose endpoints are already readable topics.
 *
 * @param options - roots, caller, and the permission seam.
 * @returns The tree, with denied graph names absent and only counted.
 */
export async function scanKnowledgeGraphs(options: KnowledgeGraphScanOptions): Promise<KnowledgeGraphTree> {
  const byScope = new Map<KnowledgeGraphScopeKey, Map<string, KnowledgeGraphGroup>>()
  for (const key of SCOPE_ORDER) byScope.set(key, new Map())
  let scanned = 0
  let visible = 0

  for (const root of options.roots) {
    const groups = byScope.get(root.key)
    if (groups === undefined) continue
    const groupKey = root.key === 'department' ? root.groupKey : ''
    let group = groups.get(groupKey)
    if (group === undefined) {
      group = { key: groupKey, label: root.groupLabel, graphs: [] }
      groups.set(groupKey, group)
    }
    const actualScopePath = under(options.actualRoot, root.actualPath)
    if (actualScopePath === undefined) continue
    const folders = (await visibleDirectories(actualScopePath))
      .filter(directory => directory.name !== KNOWLEDGE_GRAPH_META_FOLDER)
      .slice(0, MAX_SCOPE_GRAPHS)
    for (const folder of folders) {
      scanned += 1
      let allowed = false
      try {
        allowed = await options.canRead(viewJoin(root.actualPath, folder.name))
      } catch {
        // A permission question that could not be answered is a denial. This is the
        // fail-closed half of the rule; the route additionally refuses when it could
        // not even identify the caller.
        allowed = false
      }
      if (!allowed) continue
      const graph = await readGraph(options.actualRoot, root, folder.name, options.caller)
      if (graph === undefined) continue
      group.graphs.push(graph)
      visible += 1
    }
  }

  const scopes: KnowledgeGraphScope[] = SCOPE_ORDER.map((key) => {
    const groups = [...(byScope.get(key)?.values() ?? [])]
      .filter(group => group.graphs.length > 0)
      .sort((a, b) => a.key.localeCompare(b.key, 'zh-Hans-CN'))
    for (const group of groups) {
      group.graphs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    }
    return { key, groups }
  })

  return {
    scopes,
    caller: options.caller,
    actualRoot: options.actualRoot,
    scanned,
    visible,
    denied: Math.max(0, scanned - visible),
  }
}
