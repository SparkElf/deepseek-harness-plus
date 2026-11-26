/**
 * The `.graphs/` memory-graph model: manifest types, loader, validator and the
 * dependency-free front-matter reader the rest of the memory graph modules use.
 *
 * A graph is metadata plus topology; it is not a second document store:
 *
 * ```text
 * <scope>/.graphs/<graphId>/graph.json          # manifest: nodes + edges
 * <scope>/.graphs/<graphId>/links/<edgeId>.md  # optional relation body
 * <scope>/<node path>.md                       # the node body, an ordinary document
 * ```
 *
 * The split is deliberate. The manifest only references node documents by scope
 * relative path and records edge topology; every human-facing attribute (`type`,
 * `authority`, `origin`, `reviewStatus`, ...) lives in the node document's front
 * matter, so moving or editing a document never duplicates its body here.
 *
 * Failure policy: only a missing or non-JSON `graph.json` throws
 * ({@link GraphLoadError}). Everything a reader can still describe — a missing
 * body, a missing relation document, a duplicate id, an edge endpoint the
 * manifest never declared, a path that escapes the scope — becomes a
 * {@link GraphValidationIssue} on the returned graph. That keeps one bad document
 * from hiding an otherwise renderable graph.
 *
 * @module @sparkelf/dsh-knowledge-base/graph-model
 */

import { readFile, readdir } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The memory meaning a node carries; independent of the document's folder. */
export type MemoryNodeType = 'policy' | 'fact' | 'procedure' | 'case' | 'skill' | 'decision' | 'topic'

/** How strongly a node overrides other memory. `redline` may only be subscribed. */
export type MemoryAuthority = 'canonical' | 'advisory' | 'redline'

/** Who authored the node body. AI content is publishable but must stay labelled. */
export type MemoryOrigin = 'human' | 'ai' | 'mixed'

/** Review state shown in the UI. */
export type MemoryReviewStatus = 'draft' | 'reviewed' | 'approved'

/** One node reference in `graph.json`; the body lives at `path`. */
export interface GraphManifestNode { id: string; path: string }

/** One edge in `graph.json`. `doc` is an optional scope-relative relation document. */
export interface GraphManifestEdge {
  id: string; from: string; to: string; type: string; doc?: string
}

/** The `graph.json` document as written on disk. */
export interface GraphManifest {
  schemaVersion: 1; id: string; name: string; description?: string
  scope: string; version: number; status: 'draft' | 'published' | 'archived'
  owner?: string; createdAt: string; updatedAt: string; publishedAt?: string
  tags: string[]; visibility: 'private' | 'department' | 'global'
  defaultView?: { layout?: string; direction?: string }
  topics?: Array<{ id: string; title: string; description?: string }>
  nodes: GraphManifestNode[]; edges: GraphManifestEdge[]
}

/** Attributes read from a node document's front matter. */
export interface GraphNodeAttributes {
  id: string; type: MemoryNodeType; title: string
  authority: MemoryAuthority; internalizable: boolean
  origin: MemoryOrigin; reviewStatus: MemoryReviewStatus
  tags: string[]; sourceRefs: string[]
}

/** A node as loaded: attributes plus where its body lives and whether it was found. */
export interface LoadedGraphNode extends GraphNodeAttributes { path: string; missing: boolean }

/**
 * An edge as loaded.
 *
 * The manifest's edge `type` is a RELATION type (for example `depends_on`), not a
 * {@link MemoryNodeType}. The contract describes this interface as extending
 * `GraphNodeAttributes`; carrying a relation type in `type` is the only reading
 * that keeps `graph.json` authoritative for topology, so the relation type is
 * exposed here and the node-only `type` field is omitted rather than narrowed to
 * an enum that cannot express it.
 */
export interface LoadedGraphEdge extends Omit<GraphNodeAttributes, 'type'> {
  /** Relation type from `graph.json` (e.g. `depends_on`). */
  type: string
  from: string; to: string; docPath?: string; missing: boolean
}

/** One non-fatal (or validation-level fatal) problem found while loading a graph. */
export interface GraphValidationIssue {
  severity: 'error' | 'warning'
  code: 'missing-node' | 'missing-edge-doc' | 'duplicate-id' | 'unknown-endpoint'
        | 'invalid-manifest' | 'invalid-frontmatter' | 'path-escape' | 'orphan-edge'
  message: string; ref?: string
}

/** A fully loaded graph: manifest, resolved root, documents, edges and issues. */
export interface LoadedGraph {
  manifest: GraphManifest; root: string
  nodes: LoadedGraphNode[]; edges: LoadedGraphEdge[]
  issues: GraphValidationIssue[]
}

/** Why {@link loadGraph} could not even read a manifest. */
export type GraphLoadErrorCode = 'manifest-missing' | 'manifest-invalid-json' | 'invalid-graph-id'

/**
 * Thrown only when the graph manifest cannot be read at all.
 *
 * Validation problems discovered after the manifest parses are returned as
 * issues on the graph instead of thrown.
 */
export class GraphLoadError extends Error {
  readonly code: GraphLoadErrorCode
  readonly graphPath: string

  constructor(code: GraphLoadErrorCode, graphPath: string, message: string) {
    super(message)
    this.name = 'GraphLoadError'
    this.code = code
    this.graphPath = graphPath
  }
}

/** Folder that holds one directory per graph, relative to the scope root. */
const GRAPHS_FOLDER = '.graphs'

/** Folder that holds optional relation documents inside one graph directory. */
const LINKS_FOLDER = 'links'

/** Manifest file name inside `.graphs/<graphId>/`. */
const MANIFEST_FILE = 'graph.json'

const NODE_TYPES: readonly MemoryNodeType[] = ['policy', 'fact', 'procedure', 'case', 'skill', 'decision', 'topic']
const AUTHORITIES: readonly MemoryAuthority[] = ['canonical', 'advisory', 'redline']
const ORIGINS: readonly MemoryOrigin[] = ['human', 'ai', 'mixed']
const REVIEW_STATUSES: readonly MemoryReviewStatus[] = ['draft', 'reviewed', 'approved']
const GRAPH_STATUSES: readonly GraphManifest['status'][] = ['draft', 'published', 'archived']
const VISIBILITIES: readonly GraphManifest['visibility'][] = ['private', 'department', 'global']

const DEFAULT_NODE_TYPE: MemoryNodeType = 'fact'
const DEFAULT_AUTHORITY: MemoryAuthority = 'advisory'
const DEFAULT_ORIGIN: MemoryOrigin = 'human'
const DEFAULT_REVIEW_STATUS: MemoryReviewStatus = 'draft'

/** Deterministic string order (code units, locale independent). */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Whether two strings name the same file system entry using simple code-unit order. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether an fs error carries the given errno code. */
const isErrnoCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null
  && 'code' in error
  && (error as { code?: unknown }).code === code

const errorIssue = (
  code: GraphValidationIssue['code'],
  message: string,
  ref?: string,
): GraphValidationIssue => (ref === undefined
  ? { severity: 'error', code, message }
  : { severity: 'error', code, message, ref })

const warningIssue = (
  code: GraphValidationIssue['code'],
  message: string,
  ref?: string,
): GraphValidationIssue => (ref === undefined
  ? { severity: 'warning', code, message }
  : { severity: 'warning', code, message, ref })

/**
 * Whether a value is a safe scope-relative path.
 *
 * The contract fixes `/` as the separator and forbids `..`, absolute paths and
 * NUL. This is stricter than that list on purpose: it also rejects empty
 * segments and backslashes, because a backslash is a Windows separator that could
 * escape the root on another host and never appears in a portable `/` path.
 */
const isSafeRelativePath = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  if (/^[A-Za-z]:[\\/]/u.test(value)) return false
  if (value.includes('\\')) return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/** Resolve `relPath` under `rootAbs`, returning undefined when the result escapes the root. */
const pathInsideRoot = (rootAbs: string, relPath: string): string | undefined => {
  const absolute = resolve(rootAbs, relPath)
  const rel = relative(rootAbs, absolute)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return absolute
}

/** Human title fallback: the file name without its extension. */
const titleFromPath = (relPath: string): string => {
  const name = relPath.split('/').pop() ?? relPath
  const extension = extname(name)
  return extension === '' ? name : name.slice(0, -extension.length)
}

// ---------------------------------------------------------------------------
// Front matter: a deliberately small YAML subset.
// ---------------------------------------------------------------------------

interface FrontMatterBlock {
  /** The lines between the opening and closing `---`. */
  lines: string[]
  /** The document body after the closing delimiter. */
  body: string
  /** True when an opening `---` had no matching closing `---`. */
  unterminated: boolean
}

/**
 * Split a document into front-matter lines and body.
 *
 * Returns undefined when the document does not start with a `---` line. The body
 * of an unterminated block is the whole source: a parser error should not
 * silently delete content.
 */
const splitFrontMatter = (source: string): FrontMatterBlock | undefined => {
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source
  const lines = text.split(/\r?\n/u)
  if (lines.length === 0 || lines[0].replace(/[ \t]+$/u, '') !== '---') return undefined
  let closing = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].replace(/[ \t]+$/u, '') === '---') {
      closing = index
      break
    }
  }
  if (closing === -1) return { lines: lines.slice(1), body: text, unterminated: true }
  return { lines: lines.slice(1, closing), body: lines.slice(closing + 1).join('\n'), unterminated: false }
}

/** A parsed scalar: quoted strings stay strings, bare `true`/`false` become booleans. */
type ParsedValue =
  | { kind: 'scalar'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'array'; value: string[] }

/** Remove an unquoted trailing ` # comment`. */
const stripInlineComment = (value: string): string => {
  let quote: '"' | "'" | undefined
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote === '"') {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        quote = undefined
      }
      continue
    }
    if (quote === "'") {
      if (char === "'") {
        if (value[index + 1] === "'") {
          index += 1
        } else {
          quote = undefined
        }
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/u.test(value[index - 1]))) return value.slice(0, index).trimEnd()
  }
  return value.trimEnd()
}

/** Unquote a single- or double-quoted scalar; undefined when the quotes do not balance. */
const unquote = (raw: string): string | undefined => {
  if (raw.length < 2) return undefined
  const quote = raw[0]
  if ((quote !== '"' && quote !== "'") || raw[raw.length - 1] !== quote) return undefined
  const inner = raw.slice(1, -1)
  if (quote === "'") return inner.replace(/''/gu, "'")
  let result = ''
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]
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

/** Parse `[a, "b, c"]` into its values; undefined when the array is malformed. */
const parseFlowArray = (raw: string): string[] | undefined => {
  if (!raw.startsWith('[') || !raw.endsWith(']')) return undefined
  const inner = raw.slice(1, -1).trim()
  if (inner === '') return []
  const items: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaped = false
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]
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
          current += inner[index + 1]
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
      const text = unquote(item)
      if (text === undefined) return undefined
      values.push(text)
      continue
    }
    if (item.includes('[') || item.includes(']')) return undefined
    values.push(item)
  }
  return values
}

/** Parse one YAML scalar/array value; undefined when the subset cannot express it. */
const parseValue = (rawInput: string): ParsedValue | undefined => {
  const raw = stripInlineComment(rawInput).trim()
  if (raw === '') return { kind: 'scalar', value: '' }
  if (raw.startsWith('[')) {
    const values = parseFlowArray(raw)
    return values === undefined ? undefined : { kind: 'array', value: values }
  }
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const text = unquote(raw)
    return text === undefined ? undefined : { kind: 'scalar', value: text }
  }
  if (raw === 'true') return { kind: 'boolean', value: true }
  if (raw === 'false') return { kind: 'boolean', value: false }
  return { kind: 'scalar', value: raw }
}

interface FrontMatterEntries {
  entries: Map<string, ParsedValue>
  errors: string[]
}

/** Parse `key: value` lines; nested structures are rejected rather than guessed at. */
const parseFrontMatterLines = (lines: string[]): FrontMatterEntries => {
  const entries = new Map<string, ParsedValue>()
  const errors: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
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
    const [, key, rawValue] = match
    if (entries.has(key)) {
      errors.push(`line ${index + 1}: duplicate key "${key}"`)
      continue
    }
    const parsed = parseValue(rawValue)
    if (parsed === undefined) {
      errors.push(`line ${index + 1}: unsupported value for "${key}"`)
      continue
    }
    entries.set(key, parsed)
  }
  return { entries, errors }
}

const scalarString = (value: ParsedValue | undefined, field: string, errors: string[]): string | undefined => {
  if (value === undefined) return undefined
  if (value.kind !== 'scalar' || value.value.trim() === '') {
    errors.push(`front matter "${field}" must be a non-empty string`)
    return undefined
  }
  return value.value
}

const enumValue = <T extends string>(
  value: ParsedValue | undefined,
  allowed: readonly T[],
  fallback: T,
  field: string,
  errors: string[],
): T => {
  if (value === undefined) return fallback
  if (value.kind !== 'scalar' || !(allowed as readonly string[]).includes(value.value)) {
    errors.push(`front matter "${field}" must be one of ${allowed.join(', ')}`)
    return fallback
  }
  return value.value as T
}

const booleanValue = (
  value: ParsedValue | undefined,
  fallback: boolean,
  field: string,
  errors: string[],
): boolean => {
  if (value === undefined) return fallback
  if (value.kind !== 'boolean') {
    errors.push(`front matter "${field}" must be true or false`)
    return fallback
  }
  return value.value
}

const stringArrayValue = (
  value: ParsedValue | undefined,
  fallback: string[],
  field: string,
  errors: string[],
): string[] => {
  if (value === undefined) return fallback
  if (value.kind !== 'array') {
    errors.push(`front matter "${field}" must be an inline array such as [a, b]`)
    return fallback
  }
  return value.value
}

interface FrontMatterOptions {
  /** Value used when front matter omits `id`; when absent a missing id is an error. */
  idFallback?: string
  /** Value used when front matter omits `title`; when absent a missing title is an error. */
  titleFallback?: string
  /**
   * Severity for a document that has no front matter block at all.
   *
   * Standalone parsing is strict (the document does not describe a node). The
   * loader downgrades this to a warning: a legacy document can still be a valid
   * node body with default attributes while it waits for annotation, and the
   * contract's fatal validator errors do not include "unannotated document".
   */
  missingBlockSeverity?: 'error' | 'warning'
}

interface ParsedNodeFrontMatter {
  attributes: GraphNodeAttributes | null
  body: string
  issues: GraphValidationIssue[]
}

/** Parse node attributes from front matter, applying the contract defaults. */
const parseFrontMatter = (source: string, options: FrontMatterOptions): ParsedNodeFrontMatter => {
  const block = splitFrontMatter(source)
  if (block === undefined) {
    const message = 'document does not start with a --- front matter block'
    return {
      attributes: null,
      body: source,
      issues: [(options.missingBlockSeverity ?? 'error') === 'warning'
        ? warningIssue('invalid-frontmatter', `${message}; default node attributes are used`)
        : errorIssue('invalid-frontmatter', message)],
    }
  }
  if (block.unterminated) {
    return {
      attributes: null,
      body: source,
      issues: [errorIssue('invalid-frontmatter', 'front matter block is not closed with ---')],
    }
  }

  const { entries, errors } = parseFrontMatterLines(block.lines)

  let id = scalarString(entries.get('id'), 'id', errors)
  if (id === undefined && entries.get('id') === undefined) {
    if (options.idFallback === undefined) errors.push('front matter is missing required "id"')
    else id = options.idFallback
  }
  let title = scalarString(entries.get('title'), 'title', errors)
  if (title === undefined && entries.get('title') === undefined) {
    if (options.titleFallback === undefined) errors.push('front matter is missing required "title"')
    else title = options.titleFallback
  }

  const type = enumValue(entries.get('type'), NODE_TYPES, DEFAULT_NODE_TYPE, 'type', errors)
  const authority = enumValue(entries.get('authority'), AUTHORITIES, DEFAULT_AUTHORITY, 'authority', errors)
  const internalizable = booleanValue(entries.get('internalizable'), true, 'internalizable', errors)
  const origin = enumValue(entries.get('origin'), ORIGINS, DEFAULT_ORIGIN, 'origin', errors)
  const reviewStatus = enumValue(entries.get('reviewStatus'), REVIEW_STATUSES, DEFAULT_REVIEW_STATUS, 'reviewStatus', errors)
  const tags = stringArrayValue(entries.get('tags'), [], 'tags', errors)
  const sourceRefs = stringArrayValue(entries.get('sourceRefs'), [], 'sourceRefs', errors)

  if (errors.length > 0 || id === undefined || title === undefined) {
    return {
      attributes: null,
      body: block.body,
      issues: errors.map(message => errorIssue('invalid-frontmatter', message)),
    }
  }
  return {
    attributes: { id, type, title, authority, internalizable, origin, reviewStatus, tags, sourceRefs },
    body: block.body,
    issues: [],
  }
}

/**
 * Read a node document's front matter.
 *
 * Supported syntax is the documented subset: `key: value`, quoted strings and
 * `[a, b]` inline arrays. Optional attributes fall back to `type=fact`,
 * `authority=advisory`, `internalizable=true`, `origin=human`,
 * `reviewStatus=draft`, `tags=[]` and `sourceRefs=[]`. `id` and `title` are
 * required here because this function has no manifest or file name to fall back
 * to; {@link loadGraph} supplies both when a manifest already names the node.
 *
 * Invalid enum values are errors rather than defaults: silently downgrading an
 * unknown `authority` to `advisory` could turn a mistyped redline into
 * internalizable memory.
 */
export function parseNodeFrontMatter(source: string): { attributes: GraphNodeAttributes | null; body: string; issues: GraphValidationIssue[] } {
  return parseFrontMatter(source, {})
}

// ---------------------------------------------------------------------------
// Manifest parsing.
// ---------------------------------------------------------------------------

const emptyManifest = (graphId: string): GraphManifest => ({
  schemaVersion: 1,
  id: graphId,
  name: graphId,
  scope: '',
  version: 1,
  status: 'draft',
  createdAt: '',
  updatedAt: '',
  tags: [],
  visibility: 'private',
  nodes: [],
  edges: [],
})

const requiredString = (
  value: unknown,
  fallback: string,
  field: string,
  report: (message: string) => void,
): string => {
  if (typeof value === 'string' && value.trim() !== '') return value
  report(`"${field}" must be a non-empty string`)
  return fallback
}

const optionalString = (
  value: unknown,
  field: string,
  report: (message: string) => void,
): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    report(`"${field}" must be a string`)
    return undefined
  }
  return value
}

const requiredEnum = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  field: string,
  report: (message: string) => void,
): T => {
  if (value === undefined) {
    report(`"${field}" is required and must be one of ${allowed.join(', ')}`)
    return fallback
  }
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    report(`"${field}" must be one of ${allowed.join(', ')}`)
    return fallback
  }
  return value as T
}

const parseStringArray = (
  value: unknown,
  field: string,
  report: (message: string) => void,
): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    report(`"${field}" must be an array of strings`)
    return []
  }
  return value as string[]
}

/** Validate and normalize a parsed `graph.json` value. Invalid input becomes issues. */
const parseManifest = (
  raw: unknown,
  graphId: string,
  manifestPath: string,
): { manifest: GraphManifest; issues: GraphValidationIssue[] } => {
  const issues: GraphValidationIssue[] = []
  const report = (message: string): void => {
    issues.push(errorIssue('invalid-manifest', message, manifestPath))
  }
  if (!isRecord(raw)) {
    report('graph.json must contain a JSON object')
    return { manifest: emptyManifest(graphId), issues }
  }

  if (raw.schemaVersion !== 1) report('"schemaVersion" must be 1')
  const id = requiredString(raw.id, graphId, 'id', report)
  const name = requiredString(raw.name, id, 'name', report)
  const description = optionalString(raw.description, 'description', report)
  const scope = requiredString(raw.scope, '', 'scope', report)
  let version = 1
  if (typeof raw.version === 'number' && Number.isFinite(raw.version)) {
    version = raw.version
  } else {
    report('"version" must be a finite number')
  }
  const status = requiredEnum(raw.status, GRAPH_STATUSES, 'draft', 'status', report)
  const owner = optionalString(raw.owner, 'owner', report)
  const createdAt = requiredString(raw.createdAt, '', 'createdAt', report)
  const updatedAt = requiredString(raw.updatedAt, '', 'updatedAt', report)
  const publishedAt = optionalString(raw.publishedAt, 'publishedAt', report)
  const tags = parseStringArray(raw.tags, 'tags', report)
  const visibility = requiredEnum(raw.visibility, VISIBILITIES, 'private', 'visibility', report)

  let defaultView: GraphManifest['defaultView']
  if (raw.defaultView !== undefined) {
    if (!isRecord(raw.defaultView)) {
      report('"defaultView" must be an object')
    } else {
      const layout = optionalString(raw.defaultView.layout, 'defaultView.layout', report)
      const direction = optionalString(raw.defaultView.direction, 'defaultView.direction', report)
      defaultView = { layout, direction }
    }
  }

  let topics: GraphManifest['topics']
  if (raw.topics !== undefined) {
    if (!Array.isArray(raw.topics)) {
      report('"topics" must be an array')
    } else {
      const parsedTopics: NonNullable<GraphManifest['topics']> = []
      raw.topics.forEach((item, index) => {
        if (
          !isRecord(item)
          || typeof item.id !== 'string' || item.id.trim() === ''
          || typeof item.title !== 'string' || item.title.trim() === ''
        ) {
          report(`"topics[${index}]" must have a non-empty "id" and "title"`)
          return
        }
        const itemDescription = optionalString(item.description, `topics[${index}].description`, report)
        parsedTopics.push(
          itemDescription === undefined
            ? { id: item.id, title: item.title }
            : { id: item.id, title: item.title, description: itemDescription },
        )
      })
      topics = parsedTopics
    }
  }

  const nodes: GraphManifestNode[] = []
  if (!Array.isArray(raw.nodes)) {
    report('"nodes" must be an array')
  } else {
    raw.nodes.forEach((item, index) => {
      if (
        !isRecord(item)
        || typeof item.id !== 'string' || item.id.trim() === ''
        || typeof item.path !== 'string' || item.path.trim() === ''
      ) {
        report(`"nodes[${index}]" must have a non-empty "id" and "path"`)
        return
      }
      nodes.push({ id: item.id, path: item.path })
    })
  }

  const edges: GraphManifestEdge[] = []
  if (!Array.isArray(raw.edges)) {
    report('"edges" must be an array')
  } else {
    raw.edges.forEach((item, index) => {
      if (
        !isRecord(item)
        || typeof item.id !== 'string' || item.id.trim() === ''
        || typeof item.from !== 'string' || item.from.trim() === ''
        || typeof item.to !== 'string' || item.to.trim() === ''
        || typeof item.type !== 'string' || item.type.trim() === ''
      ) {
        report(`"edges[${index}]" must have non-empty "id", "from", "to" and "type"`)
        return
      }
      const doc = optionalString(item.doc, `edges[${index}].doc`, report)
      edges.push(doc === undefined
        ? { id: item.id, from: item.from, to: item.to, type: item.type }
        : { id: item.id, from: item.from, to: item.to, type: item.type, doc })
    })
  }

  return {
    manifest: {
      schemaVersion: 1,
      id,
      name,
      ...(description === undefined ? {} : { description }),
      scope,
      version,
      status,
      ...(owner === undefined ? {} : { owner }),
      createdAt,
      updatedAt,
      ...(publishedAt === undefined ? {} : { publishedAt }),
      tags,
      visibility,
      ...(defaultView === undefined ? {} : { defaultView }),
      ...(topics === undefined ? {} : { topics }),
      nodes,
      edges,
    },
    issues,
  }
}

// ---------------------------------------------------------------------------
// Document loading.
// ---------------------------------------------------------------------------

const fallbackNodeAttributes = (id: string, title: string): GraphNodeAttributes => ({
  id,
  type: DEFAULT_NODE_TYPE,
  title,
  authority: DEFAULT_AUTHORITY,
  internalizable: true,
  origin: DEFAULT_ORIGIN,
  reviewStatus: DEFAULT_REVIEW_STATUS,
  tags: [],
  sourceRefs: [],
})

interface LoadedNodeResult {
  node: LoadedGraphNode
  issues: GraphValidationIssue[]
}

/** Load one node body and its front matter. Missing/unreadable bodies become issues. */
const loadNode = async (root: string, manifestNode: GraphManifestNode): Promise<LoadedNodeResult> => {
  const issues: GraphValidationIssue[] = []
  const fallback = fallbackNodeAttributes(manifestNode.id, titleFromPath(manifestNode.path))
  if (!isSafeRelativePath(manifestNode.path)) {
    issues.push(errorIssue(
      'path-escape',
      `node "${manifestNode.id}" path "${manifestNode.path}" is not a safe scope-relative path`,
      manifestNode.path,
    ))
    return { node: { ...fallback, path: manifestNode.path, missing: true }, issues }
  }
  const absolute = pathInsideRoot(root, manifestNode.path)
  if (absolute === undefined) {
    issues.push(errorIssue(
      'path-escape',
      `node "${manifestNode.id}" path "${manifestNode.path}" escapes the scope root`,
      manifestNode.path,
    ))
    return { node: { ...fallback, path: manifestNode.path, missing: true }, issues }
  }

  let source: string
  try {
    source = await readFile(absolute, 'utf8')
  } catch (error) {
    const reason = isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')
      ? 'does not exist'
      : `could not be read (${error instanceof Error ? error.message : String(error)})`
    issues.push(errorIssue(
      'missing-node',
      `node "${manifestNode.id}" document "${manifestNode.path}" ${reason}`,
      manifestNode.path,
    ))
    return { node: { ...fallback, path: manifestNode.path, missing: true }, issues }
  }

  const parsed = parseFrontMatter(source, {
    idFallback: manifestNode.id,
    titleFallback: titleFromPath(manifestNode.path),
    missingBlockSeverity: 'warning',
  })
  issues.push(...parsed.issues.map(issue => (
    issue.ref === undefined ? { ...issue, ref: manifestNode.path } : issue
  )))
  if (parsed.attributes === null) {
    return { node: { ...fallback, path: manifestNode.path, missing: false }, issues }
  }
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

interface EdgeAttributes {
  id: string
  title: string
  authority: MemoryAuthority
  internalizable: boolean
  origin: MemoryOrigin
  reviewStatus: MemoryReviewStatus
  tags: string[]
  sourceRefs: string[]
  /** The relation type written in the edge document, when it has one. */
  relationType?: string
}

interface ParsedEdgeFrontMatter {
  attributes: EdgeAttributes | null
  issues: GraphValidationIssue[]
}

/** Parse an optional relation document. Its `type` is a free-form relation label. */
const parseEdgeFrontMatter = (source: string, edgeId: string): ParsedEdgeFrontMatter => {
  const block = splitFrontMatter(source)
  if (block === undefined || block.unterminated) {
    return {
      attributes: null,
      issues: [warningIssue(
        'invalid-frontmatter',
        block === undefined
          ? `edge "${edgeId}" document has no front matter; defaults are used`
          : `edge "${edgeId}" document front matter is not closed with ---; defaults are used`,
      )],
    }
  }
  const { entries, errors } = parseFrontMatterLines(block.lines)

  const id = scalarString(entries.get('id'), 'id', errors) ?? edgeId
  const title = scalarString(entries.get('title'), 'title', errors) ?? id
  const authority = enumValue(entries.get('authority'), AUTHORITIES, DEFAULT_AUTHORITY, 'authority', errors)
  const internalizable = booleanValue(entries.get('internalizable'), true, 'internalizable', errors)
  const origin = enumValue(entries.get('origin'), ORIGINS, DEFAULT_ORIGIN, 'origin', errors)
  const reviewStatus = enumValue(entries.get('reviewStatus'), REVIEW_STATUSES, DEFAULT_REVIEW_STATUS, 'reviewStatus', errors)
  const tags = stringArrayValue(entries.get('tags'), [], 'tags', errors)
  const sourceRefs = stringArrayValue(entries.get('sourceRefs'), [], 'sourceRefs', errors)
  const relationType = scalarString(entries.get('type'), 'type', errors)

  if (errors.length > 0) {
    return {
      attributes: null,
      issues: errors.map(message => errorIssue('invalid-frontmatter', message)),
    }
  }
  return {
    attributes: {
      id,
      title,
      authority,
      internalizable,
      origin,
      reviewStatus,
      tags,
      sourceRefs,
      ...(relationType === undefined ? {} : { relationType }),
    },
    issues: [],
  }
}

interface LoadedEdgeResult {
  edge: LoadedGraphEdge
  issues: GraphValidationIssue[]
}

/** Load one edge and its optional relation document. */
const loadEdge = async (
  root: string,
  graphId: string,
  manifestEdge: GraphManifestEdge,
): Promise<LoadedEdgeResult> => {
  const issues: GraphValidationIssue[] = []
  const fallback: LoadedGraphEdge = {
    id: manifestEdge.id,
    type: manifestEdge.type,
    from: manifestEdge.from,
    to: manifestEdge.to,
    title: manifestEdge.id,
    authority: DEFAULT_AUTHORITY,
    internalizable: true,
    origin: DEFAULT_ORIGIN,
    reviewStatus: DEFAULT_REVIEW_STATUS,
    tags: [],
    sourceRefs: [],
    missing: false,
  }

  const explicit = manifestEdge.doc !== undefined
  const candidate = manifestEdge.doc ?? `${GRAPHS_FOLDER}/${graphId}/${LINKS_FOLDER}/${manifestEdge.id}.md`
  let docPath: string | undefined
  let source: string | undefined
  let missing = false

  if (!isSafeRelativePath(candidate)) {
    issues.push(errorIssue(
      'path-escape',
      `edge "${manifestEdge.id}" document path "${candidate}" is not a safe scope-relative path`,
      candidate,
    ))
    missing = true
  } else {
    const absolute = pathInsideRoot(root, candidate)
    if (absolute === undefined) {
      issues.push(errorIssue(
        'path-escape',
        `edge "${manifestEdge.id}" document path "${candidate}" escapes the scope root`,
        candidate,
      ))
      missing = true
    } else {
      try {
        source = await readFile(absolute, 'utf8')
        docPath = candidate
      } catch (error) {
        if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
          if (explicit) {
            issues.push(warningIssue(
              'missing-edge-doc',
              `edge "${manifestEdge.id}" document "${candidate}" does not exist`,
              candidate,
            ))
            docPath = candidate
            missing = true
          }
          // No `doc` in the manifest and no default relation body: a topology-only
          // edge is valid, so nothing is reported.
        } else {
          issues.push(warningIssue(
            'missing-edge-doc',
            `edge "${manifestEdge.id}" document "${candidate}" could not be read`,
            candidate,
          ))
          docPath = candidate
          missing = true
        }
      }
    }
  }

  if (source !== undefined && docPath !== undefined) {
    const parsed = parseEdgeFrontMatter(source, manifestEdge.id)
    issues.push(...parsed.issues.map(issue => (
      issue.ref === undefined ? { ...issue, ref: docPath } : issue
    )))
    if (parsed.attributes !== null) {
      const { id, title, authority, internalizable, origin, reviewStatus, tags, sourceRefs, relationType } = parsed.attributes
      if (relationType !== undefined && relationType !== manifestEdge.type) {
        issues.push(warningIssue(
          'invalid-frontmatter',
          `edge front matter type "${relationType}" does not match graph.json type "${manifestEdge.type}"; graph.json wins`,
          docPath,
        ))
      }
      if (id !== manifestEdge.id) {
        issues.push(warningIssue(
          'invalid-frontmatter',
          `edge front matter id "${id}" does not match graph.json id "${manifestEdge.id}"; graph.json wins`,
          docPath,
        ))
      }
      return {
        edge: {
          ...fallback,
          id: manifestEdge.id,
          type: manifestEdge.type,
          title,
          authority,
          internalizable,
          origin,
          reviewStatus,
          tags,
          sourceRefs,
          docPath,
          missing,
        },
        issues,
      }
    }
  }

  return {
    edge: { ...fallback, docPath, missing },
    issues,
  }
}

/** Merge issue groups, dropping exact repeats while preserving first-seen order. */
const mergeIssues = (...groups: GraphValidationIssue[][]): GraphValidationIssue[] => {
  const seen = new Set<string>()
  const merged: GraphValidationIssue[] = []
  for (const group of groups) {
    for (const item of group) {
      const key = `${item.severity}|${item.code}|${item.ref ?? ''}|${item.message}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(item)
    }
  }
  return merged
}

/**
 * Load one graph from `<scopeRoot>/.graphs/<graphId>/graph.json`.
 *
 * Node bodies resolve against `scopeRoot` (not against the graph directory), so a
 * node path is exactly the path an ordinary browser shows. Missing documents,
 * duplicate ids, unknown edge endpoints and unsafe paths are reported on
 * {@link LoadedGraph.issues}; only a missing or non-JSON manifest throws
 * {@link GraphLoadError}.
 *
 * @param scopeRoot - directory that owns `.graphs/`; may be relative.
 * @param graphId - the `.graphs/<graphId>` directory name (one path segment).
 * @returns the loaded graph, with issue severity already classified.
 */
export async function loadGraph(scopeRoot: string, graphId: string): Promise<LoadedGraph> {
  const root = resolve(scopeRoot)
  const graphDir = join(root, GRAPHS_FOLDER, graphId)
  if (!isSafeRelativePath(graphId) || graphId.includes('/')) {
    throw new GraphLoadError(
      'invalid-graph-id',
      graphDir,
      `graph id "${graphId}" must be one safe path segment under .graphs/`,
    )
  }

  const manifestPath = join(graphDir, MANIFEST_FILE)
  let manifestSource: string
  try {
    manifestSource = await readFile(manifestPath, 'utf8')
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      throw new GraphLoadError(
        'manifest-missing',
        manifestPath,
        `graph "${graphId}" has no ${MANIFEST_FILE} at ${manifestPath}`,
      )
    }
    throw error
  }

  let rawManifest: unknown
  try {
    rawManifest = JSON.parse(manifestSource)
  } catch (error) {
    throw new GraphLoadError(
      'manifest-invalid-json',
      manifestPath,
      `${MANIFEST_FILE} for graph "${graphId}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const parsedManifest = parseManifest(rawManifest, graphId, manifestPath)
  const manifest = parsedManifest.manifest
  const issues: GraphValidationIssue[] = [...parsedManifest.issues]
  if (manifest.id !== graphId) {
    issues.push(warningIssue(
      'invalid-manifest',
      `graph.json id "${manifest.id}" does not match its directory name "${graphId}"`,
      manifestPath,
    ))
  }

  const nodes: LoadedGraphNode[] = []
  const nodeIds = new Set<string>()
  const nodePaths = new Map<string, string>()
  for (const manifestNode of manifest.nodes) {
    if (nodeIds.has(manifestNode.id)) {
      issues.push(errorIssue('duplicate-id', `duplicate node id "${manifestNode.id}"`, manifestNode.id))
      continue
    }
    const existingOwner = nodePaths.get(manifestNode.path)
    if (existingOwner !== undefined) {
      issues.push(errorIssue(
        'invalid-manifest',
        `nodes "${existingOwner}" and "${manifestNode.id}" reference the same path "${manifestNode.path}"`,
        manifestNode.path,
      ))
    } else {
      nodePaths.set(manifestNode.path, manifestNode.id)
    }
    nodeIds.add(manifestNode.id)
    const loaded = await loadNode(root, manifestNode)
    nodes.push(loaded.node)
    issues.push(...loaded.issues)
  }

  const edges: LoadedGraphEdge[] = []
  const edgeIds = new Set<string>()
  for (const manifestEdge of manifest.edges) {
    if (edgeIds.has(manifestEdge.id)) {
      issues.push(errorIssue('duplicate-id', `duplicate edge id "${manifestEdge.id}"`, manifestEdge.id))
      continue
    }
    edgeIds.add(manifestEdge.id)
    if (!nodeIds.has(manifestEdge.from)) {
      issues.push(errorIssue(
        'unknown-endpoint',
        `edge "${manifestEdge.id}" starts at unknown node "${manifestEdge.from}"`,
        manifestEdge.id,
      ))
    }
    if (!nodeIds.has(manifestEdge.to)) {
      issues.push(errorIssue(
        'unknown-endpoint',
        `edge "${manifestEdge.id}" ends at unknown node "${manifestEdge.to}"`,
        manifestEdge.id,
      ))
    }
    const loaded = await loadEdge(root, graphId, manifestEdge)
    edges.push(loaded.edge)
    issues.push(...loaded.issues)
  }

  // A relation document that no manifest edge references is an orphan: it would
  // never be read by any consumer, so surfacing it is the only way it gets fixed.
  const referencedDocs = new Set(edges.map(edge => edge.docPath).filter((path): path is string => path !== undefined))
  try {
    const linkEntries = await readdir(join(graphDir, LINKS_FOLDER), { withFileTypes: true })
    const linkNames = linkEntries
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map(entry => entry.name)
      .sort(compareText)
    for (const name of linkNames) {
      const relPath = `${GRAPHS_FOLDER}/${graphId}/${LINKS_FOLDER}/${name}`
      if (referencedDocs.has(relPath)) continue
      issues.push(warningIssue(
        'orphan-edge',
        `relation document "${relPath}" is not referenced by any graph.json edge`,
        relPath,
      ))
    }
  } catch (error) {
    if (!isErrnoCode(error, 'ENOENT') && !isErrnoCode(error, 'ENOTDIR')) throw error
  }

  const loaded: LoadedGraph = { manifest, root, nodes, edges, issues }
  return { ...loaded, issues: mergeIssues(issues, validateGraph(loaded)) }
}

/**
 * Validate an already-loaded graph and return its error-level issues.
 *
 * Warnings (a missing optional edge document, an orphan relation file) are not
 * returned: the contract's validator answers "may this graph be published", and
 * those problems never make the topology unusable. Checks are recomputed from
 * the loaded data so a manually constructed graph is validated as thoroughly as
 * one returned by {@link loadGraph}.
 */
export function validateGraph(graph: LoadedGraph): GraphValidationIssue[] {
  const structural: GraphValidationIssue[] = []
  const knownErrors = new Set(
    graph.issues
      .filter(item => item.severity === 'error')
      .map(item => `${item.code}|${item.ref ?? ''}`),
  )
  const push = (item: GraphValidationIssue): void => {
    const key = `${item.code}|${item.ref ?? ''}`
    if (knownErrors.has(key)) return
    knownErrors.add(key)
    structural.push(item)
  }

  const nodeIds = new Set<string>()
  const nodePaths = new Set<string>()
  for (const node of graph.nodes) {
    if (!isSafeRelativePath(node.path)) {
      push(errorIssue('path-escape', `node "${node.id}" path "${node.path}" is not safe`, node.path))
    } else if (node.missing) {
      push(errorIssue('missing-node', `node "${node.id}" document "${node.path}" is missing`, node.path))
    }
    if (nodeIds.has(node.id)) {
      push(errorIssue('duplicate-id', `duplicate node id "${node.id}"`, node.id))
    }
    nodeIds.add(node.id)
    if (nodePaths.has(node.path)) {
      push(errorIssue('invalid-manifest', `more than one node references "${node.path}"`, node.path))
    }
    nodePaths.add(node.path)
  }

  const edgeIds = new Set<string>()
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      push(errorIssue('duplicate-id', `duplicate edge id "${edge.id}"`, edge.id))
    }
    edgeIds.add(edge.id)
    if (!nodeIds.has(edge.from)) {
      push(errorIssue('unknown-endpoint', `edge "${edge.id}" starts at unknown node "${edge.from}"`, edge.id))
    }
    if (!nodeIds.has(edge.to)) {
      push(errorIssue('unknown-endpoint', `edge "${edge.id}" ends at unknown node "${edge.to}"`, edge.id))
    }
    if (edge.docPath !== undefined && !isSafeRelativePath(edge.docPath)) {
      push(errorIssue('path-escape', `edge "${edge.id}" document path "${edge.docPath}" is not safe`, edge.docPath))
    }
  }

  return [
    ...graph.issues.filter(item => item.severity === 'error'),
    ...structural,
  ]
}

/**
 * List the graphs under `<scopeRoot>/.graphs/`, sorted by directory id.
 *
 * `id` is the `.graphs/<id>` directory name, which is what {@link loadGraph}
 * takes; `manifest.id` is normally identical. Directories that contain no
 * readable `graph.json` are skipped rather than invented: a caller that knows a
 * graph should exist can call {@link loadGraph} and receive the precise
 * {@link GraphLoadError}.
 */
export async function listGraphs(scopeRoot: string): Promise<Array<{ id: string; manifest: GraphManifest; issueCount: number }>> {
  const root = resolve(scopeRoot)
  const graphsDir = join(root, GRAPHS_FOLDER)
  let entries
  try {
    entries = await readdir(graphsDir, { withFileTypes: true })
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) return []
    throw error
  }

  const ids = entries
    .filter(entry => entry.isDirectory() && isSafeRelativePath(entry.name) && !entry.name.includes('/'))
    .map(entry => entry.name)
    .sort(compareText)

  const result: Array<{ id: string; manifest: GraphManifest; issueCount: number }> = []
  for (const id of ids) {
    try {
      const graph = await loadGraph(root, id)
      result.push({ id, manifest: graph.manifest, issueCount: graph.issues.length })
    } catch (error) {
      if (error instanceof GraphLoadError) continue
      throw error
    }
  }
  return result
}
