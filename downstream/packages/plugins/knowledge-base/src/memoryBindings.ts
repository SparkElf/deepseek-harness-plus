/**
 * Personal memory bindings: the per-user record of how a user relates to a
 * department/global graph node or edge (`pending` / `subscribe` / `internalize`).
 *
 * Storage is deliberately dumb and local:
 *
 * ```text
 * <usersRoot>/<userId>/bindings/<sourceType>-<sourceId>.yaml
 * ```
 *
 * - one hand-written simple YAML file per source, never a central index;
 * - `list()` rebuilds the whole answer from the directory, so deleting a file
 *   is the same thing as deleting the binding;
 * - every write is atomic (`tmp` file + `rename`), so a crash cannot leave a
 *   half-written binding behind;
 * - binding files are local state and must not be committed to Git. The caller
 *   owns that decision; this module only writes under `<usersRoot>`.
 *
 * The YAML dialect is intentionally tiny: `key: scalar`, quoted strings,
 * `[a, b]` arrays, one level of nested map (used by `lineage`) and `#`
 * comments. Unknown keys are ignored when reading, which lets a newer guardian
 * add bookkeeping fields without breaking older readers.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-bindings
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** What a binding points at. */
export type BindingSourceType = 'node' | 'edge'

/** Lifecycle of a personal binding. */
export type BindingMode = 'pending' | 'subscribe' | 'internalize'

/** Health of a binding after its source moved on or its policy changed. */
export type BindingStatus = 'active' | 'stale' | 'revoked'

/** A concrete mode a pending binding asks the guardian to apply. */
export type RequestedBindingMode = Exclude<BindingMode, 'pending'>

/** Provenance of a personal branch. */
export interface BindingLineage {
  subscribedAt?: string
  forkedFromVersion?: number
  forkedAt?: string
  divergence?: string[]
}

/**
 * One user's relationship to one graph source.
 *
 * `localPath` has two meanings, keyed by `mode`:
 *
 * - `internalize`: the personal copy, relative to `<usersRoot>/<userId>`
 *   (`memory/<graphId>/<sourceId>.md`);
 * - `subscribe`: the source document path relative to the graph scope root
 *   (e.g. `制度/采购制度.md`). It is a proxy reference only - no body is
 *   copied, and the runtime reads the department document live.
 * - `pending`: absent.
 *
 * `requestedMode` is the hand-off used by the UI: a user writes
 * `{ mode: 'pending', requestedMode: 'internalize' }` and the guardian session
 * (the single writer of binding files) performs the copy on its next pass.
 * Without a request, a pending binding is resolved to `subscribe`, which is
 * always safe because it copies no content.
 */
export interface PersonalBinding {
  userId: string
  sourceType: BindingSourceType
  sourceId: string
  graphId: string
  mode: BindingMode
  sourceVersion: number
  sourceCommit?: string
  lineage: BindingLineage
  status: BindingStatus
  updatedAt: string
  localPath?: string
  requestedMode?: RequestedBindingMode
}

/** Raised when a binding file or a binding value is unusable. */
export class BindingStoreError extends Error {
  readonly filePath?: string

  constructor(message: string, filePath?: string) {
    super(message)
    this.name = 'BindingStoreError'
    this.filePath = filePath
  }
}

const SOURCE_TYPES: readonly BindingSourceType[] = ['node', 'edge']
const MODES: readonly BindingMode[] = ['pending', 'subscribe', 'internalize']
const STATUSES: readonly BindingStatus[] = ['active', 'stale', 'revoked']
const REQUESTED_MODES: readonly RequestedBindingMode[] = ['subscribe', 'internalize']

/**
 * Compose the binding file stem: `<sourceType>-<sourceId>`.
 *
 * The source id becomes part of a file name, so path separators, NUL bytes,
 * leading dots and surrounding whitespace are refused rather than escaped.
 * Legitimate graph ids (ASCII slugs and Chinese ids alike) are untouched.
 */
export function bindingKey(sourceType: BindingSourceType, sourceId: string): string {
  assertSourceType(sourceType)
  assertPathSegment(sourceId, 'sourceId')
  return `${sourceType}-${sourceId}`
}

/** Relative personal copy path for an internalized binding. */
export function memoryRelativePath(graphId: string, sourceId: string): string {
  assertPathSegment(graphId, 'graphId')
  assertPathSegment(sourceId, 'sourceId')
  return `memory/${graphId}/${sourceId}.md`
}

/** Absolute personal copy path for an internalized binding. */
export function memoryFilePath(usersRoot: string, userId: string, graphId: string, sourceId: string): string {
  assertPathSegment(userId, 'userId')
  return join(usersRoot, userId, ...memoryRelativePath(graphId, sourceId).split('/'))
}

/**
 * Atomic UTF-8 write: write a sibling temp file, then `rename` it over the
 * target. Same-directory temp + rename is atomic on POSIX file systems, and on
 * Windows `rename` over an existing file is supported by Node.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  options: { mode?: number } = {},
): Promise<void> {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true })
  const tempPath = join(
    directory,
    `.${basename(filePath)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`,
  )
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', mode: options.mode ?? 0o600, flag: 'wx' })
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Binding store rooted at a users directory. Paths are injected, never read
 * from global config, so tests and the runtime can point at different roots.
 */
export class BindingStore {
  private readonly usersRoot: string

  constructor(usersRoot: string) {
    if (typeof usersRoot !== 'string' || usersRoot.trim() === '') {
      throw new BindingStoreError('usersRoot must be a non-empty path')
    }
    this.usersRoot = usersRoot
  }

  /** Directory holding every binding file for one user. */
  readonlyPath(userId: string): string {
    assertPathSegment(userId, 'userId')
    return join(this.usersRoot, userId, 'bindings')
  }

  /** Rebuild the list from the binding directory; no index is kept. */
  async list(userId: string): Promise<PersonalBinding[]> {
    const directory = this.readonlyPath(userId)
    let entries: string[]
    try {
      const dirents = await readdir(directory, { withFileTypes: true })
      entries = dirents
        .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
        .map((entry) => entry.name)
        .sort()
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return []
      throw error
    }

    const bindings: PersonalBinding[] = []
    for (const name of entries) {
      const filePath = join(directory, name)
      const source = await readFile(filePath, 'utf8')
      bindings.push(parseBinding(source, filePath))
    }
    return bindings
  }

  /** Read one binding; a missing file is `undefined`, not an error. */
  async get(
    userId: string,
    sourceType: BindingSourceType,
    sourceId: string,
  ): Promise<PersonalBinding | undefined> {
    const filePath = join(this.readonlyPath(userId), `${bindingKey(sourceType, sourceId)}.yaml`)
    let source: string
    try {
      source = await readFile(filePath, 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined
      throw error
    }
    return parseBinding(source, filePath)
  }

  /** Create or replace one binding atomically. */
  async set(binding: PersonalBinding): Promise<void> {
    assertBinding(binding)
    const filePath = join(
      this.readonlyPath(binding.userId),
      `${bindingKey(binding.sourceType, binding.sourceId)}.yaml`,
    )
    await writeFileAtomic(filePath, serializeBinding(binding), { mode: 0o600 })
  }

  /** Delete one binding. Removing a file that is already gone is a no-op. */
  async remove(userId: string, sourceType: BindingSourceType, sourceId: string): Promise<void> {
    const filePath = join(this.readonlyPath(userId), `${bindingKey(sourceType, sourceId)}.yaml`)
    await rm(filePath, { force: true })
  }
}

/** Serialize a binding into the simple YAML dialect described above. */
export function serializeBinding(binding: PersonalBinding): string {
  assertBinding(binding)
  return stringifySimpleYaml({
    userId: binding.userId,
    sourceType: binding.sourceType,
    sourceId: binding.sourceId,
    graphId: binding.graphId,
    mode: binding.mode,
    sourceVersion: binding.sourceVersion,
    sourceCommit: binding.sourceCommit,
    status: binding.status,
    updatedAt: binding.updatedAt,
    localPath: binding.localPath,
    requestedMode: binding.requestedMode,
    lineage: {
      subscribedAt: binding.lineage.subscribedAt,
      forkedFromVersion: binding.lineage.forkedFromVersion,
      forkedAt: binding.lineage.forkedAt,
      divergence: binding.lineage.divergence,
    },
  })
}

/** Parse one binding file. Throws `BindingStoreError` when required fields are absent. */
export function parseBinding(source: string, filePath?: string): PersonalBinding {
  const record = parseSimpleYaml(source)
  const userId = requireString(record, 'userId', filePath)
  const sourceType = requireEnum(record, 'sourceType', SOURCE_TYPES, filePath)
  const sourceId = requireString(record, 'sourceId', filePath)
  const graphId = requireString(record, 'graphId', filePath)
  const mode = requireEnum(record, 'mode', MODES, filePath)
  const sourceVersion = requireNumber(record, 'sourceVersion', filePath)
  const status = requireEnum(record, 'status', STATUSES, filePath)
  const updatedAt = requireString(record, 'updatedAt', filePath)

  const binding: PersonalBinding = {
    userId,
    sourceType,
    sourceId,
    graphId,
    mode,
    sourceVersion,
    lineage: parseLineage(record.lineage, filePath),
    status,
    updatedAt,
  }

  const sourceCommit = optionalString(record, 'sourceCommit')
  if (sourceCommit !== undefined) binding.sourceCommit = sourceCommit
  const localPath = optionalString(record, 'localPath')
  if (localPath !== undefined) binding.localPath = assertRelativePath(localPath, 'localPath')
  const requestedMode = optionalEnum(record, 'requestedMode', REQUESTED_MODES)
  if (requestedMode !== undefined) binding.requestedMode = requestedMode

  // Catch a file whose name and identity disagree before it reaches callers.
  if (filePath !== undefined) {
    const expected = `${bindingKey(sourceType, sourceId)}.yaml`
    if (basename(filePath) !== expected) {
      throw new BindingStoreError(
        `binding file name ${JSON.stringify(basename(filePath))} does not match ${JSON.stringify(expected)}`,
        filePath,
      )
    }
  }

  return binding
}

// ---------------------------------------------------------------------------
// Simple YAML (write + read)
// ---------------------------------------------------------------------------

/** Scalar values the writer understands. */
export type YamlScalar = string | number | boolean

/** One level of nesting is enough for bindings and memory frontmatter. */
export type YamlValue = YamlScalar | YamlScalar[] | YamlRecord

/** Ordered YAML object. `undefined` entries are omitted. */
export interface YamlRecord {
  [key: string]: YamlValue | undefined
}

/** Quote a scalar when the tiny parser (or a real YAML parser) could misread it. */
export function formatYamlScalar(value: YamlScalar): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new BindingStoreError(`cannot write non-finite number ${value}`)
    return String(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value === '') return '""'
  if (needsQuoting(value)) return JSON.stringify(value)
  return value
}

/** Serialize a flat/nested record in the simple dialect. Arrays are inline. */
export function stringifySimpleYaml(record: YamlRecord): string {
  const lines: string[] = []
  appendYamlRecord(lines, record, 0)
  return `${lines.join('\n')}\n`
}

/**
 * Parse the simple dialect into string scalars (numbers, booleans and
 * timestamps stay strings so ids like `00123` survive) plus `string[]` arrays
 * and nested maps. Unknown/invalid lines are ignored; typed readers validate.
 */
export function parseSimpleYaml(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let containerKey: string | null = null
  let container: Record<string, unknown> | null = null

  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripYamlComment(rawLine)
    if (line.trim() === '') continue

    const indent = /^\s*/.exec(line)?.[0].length ?? 0
    const trimmed = line.trim()

    if (indent > 0) {
      if (containerKey === null || container === null) continue
      if (trimmed === '-' || trimmed.startsWith('- ')) {
        const value = trimmed === '-' ? '' : trimmed.slice(2).trim()
        const existing = root[containerKey]
        const list: unknown[] = Array.isArray(existing) ? existing : []
        if (!Array.isArray(existing)) root[containerKey] = list
        list.push(parseYamlScalar(value))
        continue
      }
      const pair = splitYamlKey(trimmed)
      if (!pair) continue
      if (Array.isArray(root[containerKey])) continue
      container[pair.key] = parseYamlValue(pair.rest)
      continue
    }

    containerKey = null
    container = null
    if (trimmed.startsWith('-')) continue

    const pair = splitYamlKey(trimmed)
    if (!pair) continue
    if (pair.rest === '') {
      containerKey = pair.key
      container = {}
      root[pair.key] = container
    } else {
      root[pair.key] = parseYamlValue(pair.rest)
    }
  }

  return root
}

function appendYamlRecord(lines: string[], record: YamlRecord, depth: number): void {
  const pad = '  '.repeat(depth)
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue
    assertYamlKey(key)
    if (Array.isArray(value)) {
      lines.push(`${pad}${key}: [${value.map((item) => formatYamlScalar(item)).join(', ')}]`)
      continue
    }
    if (typeof value === 'object') {
      lines.push(`${pad}${key}:`)
      appendYamlRecord(lines, value, depth + 1)
      continue
    }
    lines.push(`${pad}${key}: ${formatYamlScalar(value)}`)
  }
}

function needsQuoting(value: string): boolean {
  if (/^\s|\s$/.test(value)) return true
  if (/[\r\n\t]/.test(value)) return true
  // A colon or hash anywhere is quoted: timestamps, URLs and paths containing
  // `:` are all safer quoted than parsed as YAML structures.
  if (/[:#[\]{}&*!|>'"%@`]/.test(value)) return true
  if (/^[-?]/.test(value)) return true
  if (/^(?:~|null|true|false|yes|no|on|off)$/i.test(value)) return true
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return true
  return false
}

function stripYamlComment(line: string): string {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote === '"') {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === '"') quote = null
      continue
    }
    if (quote === "'") {
      if (char === "'" && line[index + 1] === "'") {
        index += 1
        continue
      }
      if (char === "'") quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1] ?? ''))) {
      return line.slice(0, index)
    }
  }
  return line
}

function splitYamlKey(line: string): { key: string; rest: string } | null {
  const match = /^([^:\s][^:]*):(.*)$/.exec(line)
  if (!match) return null
  return { key: match[1].trim(), rest: match[2].trim() }
}

function parseYamlValue(raw: string): unknown {
  if (raw.startsWith('[') && raw.endsWith(']')) return parseYamlInlineArray(raw)
  return parseYamlScalar(raw)
}

function parseYamlScalar(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed === 'string') return parsed
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

function parseYamlInlineArray(raw: string): string[] {
  const inner = raw.slice(1, -1).trim()
  if (inner === '') return []
  const items: string[] = []
  let buffer = ''
  let quote: '"' | "'" | null = null
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]
    if (quote === '"') {
      buffer += char
      if (char === '\\') {
        buffer += inner[index + 1] ?? ''
        index += 1
        continue
      }
      if (char === '"') quote = null
      continue
    }
    if (quote === "'") {
      buffer += char
      if (char === "'" && inner[index + 1] === "'") {
        buffer += "'"
        index += 1
        continue
      }
      if (char === "'") quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      buffer += char
      continue
    }
    if (char === ',') {
      items.push(parseYamlScalar(buffer))
      buffer = ''
      continue
    }
    buffer += char
  }
  if (buffer.trim() !== '') items.push(parseYamlScalar(buffer))
  return items
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertBinding(binding: PersonalBinding): void {
  assertPathSegment(binding.userId, 'userId')
  assertSourceType(binding.sourceType)
  assertPathSegment(binding.sourceId, 'sourceId')
  assertPathSegment(binding.graphId, 'graphId')
  assertEnum(binding.mode, MODES, 'mode')
  assertEnum(binding.status, STATUSES, 'status')
  if (binding.requestedMode !== undefined) {
    assertEnum(binding.requestedMode, REQUESTED_MODES, 'requestedMode')
  }
  if (!Number.isInteger(binding.sourceVersion) || binding.sourceVersion < 0) {
    throw new BindingStoreError(`sourceVersion must be a non-negative integer, got ${binding.sourceVersion}`)
  }
  if (typeof binding.updatedAt !== 'string' || binding.updatedAt.trim() === '') {
    throw new BindingStoreError('updatedAt must be a non-empty ISO timestamp')
  }
  if (binding.sourceCommit !== undefined && binding.sourceCommit.trim() === '') {
    throw new BindingStoreError('sourceCommit must not be blank when present')
  }
  if (binding.localPath !== undefined) assertRelativePath(binding.localPath, 'localPath')
  if (!isRecord(binding.lineage)) throw new BindingStoreError('lineage must be an object')
  const divergence = binding.lineage.divergence
  if (divergence !== undefined && (!Array.isArray(divergence) || divergence.some((item) => typeof item !== 'string'))) {
    throw new BindingStoreError('lineage.divergence must be an array of strings')
  }
}

function assertSourceType(value: unknown): asserts value is BindingSourceType {
  assertEnum(value, SOURCE_TYPES, 'sourceType')
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new BindingStoreError(`${label} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`)
  }
}

/**
 * A path segment is safe when it cannot leave its directory and cannot create
 * a hidden file. Unicode letters, spaces inside and dots inside are accepted.
 */
export function assertPathSegment(value: string, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new BindingStoreError(`${label} must be a non-empty string`)
  }
  if (value !== value.trim()) {
    throw new BindingStoreError(`${label} must not start or end with whitespace`)
  }
  if (value === '.' || value === '..' || value.startsWith('.')) {
    throw new BindingStoreError(`${label} must not be "." or start with "."`)
  }
  if (/[\u0000-\u001f\u007f/\\]/.test(value)) {
    throw new BindingStoreError(`${label} must not contain control characters or path separators`)
  }
  return value
}

/** Validate a `/`-separated relative path (graph-relative or user-relative). */
export function assertRelativePath(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BindingStoreError(`${label} must be a non-empty relative path`)
  }
  if (value !== value.trim()) {
    throw new BindingStoreError(`${label} must not start or end with whitespace`)
  }
  if (value.includes('\u0000') || value.includes('\\')) {
    throw new BindingStoreError(`${label} must not contain NUL or backslashes`)
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.startsWith('~')) {
    throw new BindingStoreError(`${label} must be relative, got ${JSON.stringify(value)}`)
  }
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new BindingStoreError(`${label} must not contain empty, "." or ".." segments`)
    }
  }
  return value
}

function requireString(record: Record<string, unknown>, key: string, filePath?: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value === '') {
    throw new BindingStoreError(`missing required field ${JSON.stringify(key)}`, filePath)
  }
  return value
}

function requireNumber(record: Record<string, unknown>, key: string, filePath?: string): number {
  const value = record[key]
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new BindingStoreError(`missing or invalid numeric field ${JSON.stringify(key)}`, filePath)
  }
  return Number(value)
}

function requireEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  filePath?: string,
): T {
  const value = record[key]
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new BindingStoreError(
      `field ${JSON.stringify(key)} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`,
      filePath,
    )
  }
  return value as T
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') throw new BindingStoreError(`field ${JSON.stringify(key)} must be a string`)
  return value
}

function optionalEnum<T extends string>(record: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const value = record[key]
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !allowed.includes(value as T)) return undefined // tolerate newer values
  return value as T
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (value === undefined || value === '') return undefined
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return undefined
}

function parseLineage(value: unknown, filePath?: string): BindingLineage {
  const record = isRecord(value) ? value : {}
  const lineage: BindingLineage = {}
  const subscribedAt = optionalString(record, 'subscribedAt')
  if (subscribedAt !== undefined) lineage.subscribedAt = subscribedAt
  const forkedFromVersion = optionalNumber(record, 'forkedFromVersion')
  if (forkedFromVersion !== undefined) lineage.forkedFromVersion = forkedFromVersion
  const forkedAt = optionalString(record, 'forkedAt')
  if (forkedAt !== undefined) lineage.forkedAt = forkedAt
  if (Array.isArray(record.divergence)) {
    lineage.divergence = record.divergence.filter((item): item is string => typeof item === 'string')
  } else if (record.divergence !== undefined && typeof record.divergence !== 'string') {
    throw new BindingStoreError('lineage.divergence must be an inline array of strings', filePath)
  }
  return lineage
}

function assertYamlKey(key: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key)) {
    throw new BindingStoreError(`unsupported YAML key ${JSON.stringify(key)}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}
