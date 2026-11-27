/**
 * Personal memory layout: raw daily logs plus the aggregate snapshots the
 * guardian maintains.
 *
 * ```text
 * <root>/
 * ├── 记忆日志/YYYY-MM-DD.md   # raw extraction + audit, append-only
 * ├── 偏好.md                 # current effective preferences, one per topic
 * ├── 踩坑.md                 # current effective pitfalls, one per error signature
 * ├── 事实.md                 # current effective facts, grouped by app · scope
 * └── SOP/<slug>.md           # one executable draft per file, versioned
 * ```
 *
 * The daily log is the only append-only surface. `偏好.md` / `踩坑.md` /
 * `事实.md` are CURRENT snapshots: an upsert replaces the old effective value
 * and never leaves two entries for the same key, so "what is true now" has one
 * home. Old values remain auditable in the daily log. A SOP has its own
 * lifecycle and version; promoting it into a skill deletes the SOP file
 * (the guardian owns that step).
 *
 * Every write is atomic (`tmp` + `rename`, shared with `memoryBindings.ts`) and
 * runs the same entry validation as the model, including the "secret means a
 * credentialRef, never a value" rule. Single-writer assumption: the guardian
 * session is the only process writing one personal memory root.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-store
 */

import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { stringifySimpleYaml, writeFileAtomic } from './memoryBindings.ts'
import {
  MEMORY_ENTRY_MARKER,
  assertValidMemoryEntry,
  isSafeMemorySlug,
  isSopStatus,
  newMemoryId,
  parseMemoryEntries,
  serializeMemoryEntry,
  type AnyMemoryEntry,
  type AppId,
  type Fact,
  type FactInput,
  type FactKind,
  type MemoryOrigin,
  type MemoryEntryInput,
  type MemoryType,
  type MemoryValidationIssue,
  type Pitfall,
  type PitfallInput,
  type Preference,
  type PreferenceInput,
  type Privacy,
  type Sop,
  type SopInput,
  type SopStatus,
} from './memoryTypes.ts'

/** Directory holding one append-only document per day. */
export const MEMORY_LOG_DIR = '记忆日志'
/** Directory holding one SOP draft per file. */
export const MEMORY_SOP_DIR = 'SOP'
/** Current effective preferences; one entry per app+topic. */
export const MEMORY_PREFERENCE_FILE = '偏好.md'
/** Current effective pitfalls; one entry per error signature. */
export const MEMORY_PITFALL_FILE = '踩坑.md'
/** Current effective facts; grouped by app and scope. */
export const MEMORY_FACT_FILE = '事实.md'
/** Append-only tombstone/audit document for user-forgotten entries. */
export const MEMORY_FORGET_FILE = '遗忘记录.md'
/** Marker that starts one tombstone record. */
export const MEMORY_FORGET_MARKER = '<!-- memory:forget -->'

/** Store construction options; `now` is injectable for deterministic tests. */
export interface MemoryStoreOptions { now?: () => Date }

/** Why a store operation failed before or during a write. */
export type MemoryStoreErrorCode =
  | 'invalid-root'
  | 'unsafe-path'
  | 'invalid-log-date'
  | 'invalid-memory-file'
  | 'duplicate-id'
  | 'sop-exists'
  | 'sop-not-found'
  | 'sop-terminal'
  | 'invalid-status-transition'
  | 'not-found'
  | 'duplicate-key'
  | 'invalid-patch'

export class MemoryStoreError extends Error {
  readonly code: MemoryStoreErrorCode

  constructor(code: MemoryStoreErrorCode, message: string) {
    super(message)
    this.name = 'MemoryStoreError'
    this.code = code
  }
}

export interface AppendLogOptions {
  /** Override the document date (`YYYY-MM-DD`); otherwise `sourceTime` or the clock decides. */
  date?: string
}

export interface AppendLogResult { id: string; date: string; path: string }
export interface PreferenceUpsertResult { id: string; path: string; created: boolean; superseded?: string }
export interface PitfallUpsertResult { id: string; path: string; created: boolean; merged: boolean }
export interface FactUpsertResult {
  id: string
  path: string
  created: boolean
  superseded?: string
  /** True when a different statement replaced the same fact key without an explicit supersede. */
  conflict: boolean
}
export interface SopWriteResult { sop: Sop; path: string }
export interface SopUpdateResult { sop: Sop; path: string }

/** Fields `updateSop` may change; everything else is immutable per version. */
export interface SopPatch {
  title?: string
  trigger?: string
  steps?: string[]
  tools?: string[]
  successCriteria?: string[]
  evidence?: string[]
  status?: SopStatus
  privacy?: Privacy
  tags?: string[]
  app?: AppId
  scenario?: string
  sourceLabel?: string
  sourceSeqs?: number[]
  origin?: MemoryOrigin
  /** Skill name/path written when the SOP is promoted. */
  promotedTo?: string[]
}

/** One entry plus the document it was read from (relative to the memory root). */
export type ListedMemoryEntry = AnyMemoryEntry & { path: string }

/** Result of forgetting one entry. */
export interface ForgetEntryResult {
  id: string
  /** Whether the entry existed and was removed from its source document. */
  removed: boolean
  /** Whether a tombstone/audit record was appended. */
  tombstoned: boolean
}

/**
 * Correctable fields of one existing entry.
 *
 * `id`, `type`, `createdAt`, document path, SOP slug/version and lifecycle
 * status are immutable here. Merge-key fields are accepted for a correction but
 * must not collide with another current entry. Unknown keys are rejected so a
 * route typo cannot silently do nothing.
 */
export interface MemoryEntryPatch {
  // Common metadata
  privacy?: Privacy
  app?: AppId
  scenario?: string
  taskType?: string
  entities?: string[]
  sourceSession?: string
  sourceTime?: string
  sourceLabel?: string
  sourceSeqs?: number[]
  origin?: MemoryOrigin
  tags?: string[]
  evidence?: string[]
  credentialRef?: string
  supersedes?: string
  body?: string
  // Preference
  topic?: string
  value?: string
  // Pitfall
  errorSignature?: string
  context?: string
  solution?: string
  appliesTo?: string[]
  // Episodic
  summary?: string
  request?: string
  outcome?: string
  sopUsed?: string[]
  promotedTo?: string[]
  // Fact
  factKind?: FactKind
  key?: string
  statement?: string
  scope?: string
  // SOP (slug, version and status stay owned by the SOP lifecycle)
  title?: string
  trigger?: string
  steps?: string[]
  tools?: string[]
  successCriteria?: string[]
}

/** Internal document classification for re-rendering after an edit/removal. */
type DocumentKind = 'preference' | 'pitfall' | 'fact' | 'log' | 'sop'

interface LocatedEntry {
  entry: AnyMemoryEntry
  path: string
  kind: DocumentKind
  doc: ReadDocument
}

/** One daily log file in the index. */
export interface MemoryLogSummary { date: string; path: string; entries: number }

/** The current personal-memory snapshot, rebuilt from files on demand. */
export interface MemoryIndex {
  root: string
  preferences: Preference[]
  pitfalls: Pitfall[]
  facts: Fact[]
  sops: Sop[]
  logs: MemoryLogSummary[]
  /** Parse problems in existing files; writes refuse to overwrite a file with issues. */
  issues: MemoryValidationIssue[]
}

interface ReadDocument {
  exists: boolean
  text: string
  entries: AnyMemoryEntry[]
  issues: MemoryValidationIssue[]
}

const PREFERENCE_HEADER = '# 偏好\n\n> 记忆守护会话维护的当前有效偏好。按 topic 去重；旧值留在记忆日志里。'
const PITFALL_HEADER = '# 踩坑\n\n> 记忆守护会话维护的当前有效踩坑。按 errorSignature 去重；解决方案更新会合并证据。'
const FACT_HEADER = '# 事实\n\n> 记忆守护会话维护的当前有效事实。按 app / scope 分节；同键冲突会覆盖旧值并标记 supersedes。'

const isErrnoCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null
  && 'code' in error
  && (error as { code?: unknown }).code === code

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Stable JSON for "did this change" comparisons, independent of key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Identity of an entry's content, ignoring generated versioning fields. */
function contentKey(entry: AnyMemoryEntry): string {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, supersedes: _supersedes, ...content } = entry
  return stableJson(content)
}

/** Copy defined patch fields only; an explicit `undefined` never erases stored data. */
function applyDefined<T extends object>(base: T, patch: Partial<T>): T {
  const result = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    ;(result as Record<string, unknown>)[key] = value
  }
  return result
}

const unionSorted = (left?: string[], right?: string[]): string[] | undefined => {
  const values = [...new Set([...(left ?? []), ...(right ?? [])])].sort()
  return values.length > 0 ? values : undefined
}

const PRIVACY_RANK: Record<Privacy, number> = { normal: 0, private: 1, sensitive: 2, secret: 3 }

/** Keep the stricter of two privacy labels when merging an existing entry. */
const stricterPrivacy = (left: Privacy, right: Privacy): Privacy =>
  PRIVACY_RANK[right] >= PRIVACY_RANK[left] ? right : left

/** Local calendar date (`YYYY-MM-DD`) for a moment; personal days are local, not UTC. */
function localDateOf(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isValidLogDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function slugifyTitle(title: string): string {
  return title
    .trim()
    .replace(/[\\/:*?"<>|#\u0000-\u001f\u007f]+/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/^[.\-]+|[.\-]+$/gu, '')
    .slice(0, 80)
}

function renderDocument(header: string, entries: readonly AnyMemoryEntry[]): string {
  const body = entries.map(entry => serializeMemoryEntry(entry)).join('\n')
  return body === '' ? `${header}\n` : `${header}\n\n${body}`
}

function renderFactDocument(entries: readonly Fact[]): string {
  const groups = new Map<string, Fact[]>()
  for (const entry of entries) {
    const key = `${entry.app ?? '通用'}\u0000${entry.scope ?? '全局'}`
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [entry])
    else bucket.push(entry)
  }
  const lines = [FACT_HEADER, '']
  for (const key of [...groups.keys()].sort()) {
    const [app, scope] = key.split('\u0000') as [string, string]
    lines.push(`## ${app} · ${scope}`, '')
    for (const entry of groups.get(key) ?? []) lines.push(serializeMemoryEntry(entry))
  }
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`
}

function sortPreferences(entries: Preference[]): Preference[] {
  return [...entries].sort((left, right) => {
    const leftKey = `${left.app ?? ''}\u0000${left.topic}`
    const rightKey = `${right.app ?? ''}\u0000${right.topic}`
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}

function sortPitfalls(entries: Pitfall[]): Pitfall[] {
  const key = (entry: Pitfall): string => entry.errorSignature.trim().toLowerCase()
  return [...entries].sort((left, right) => {
    const leftKey = key(left)
    const rightKey = key(right)
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}

function sortFacts(entries: Fact[]): Fact[] {
  const key = (entry: Fact): string => [entry.app ?? '', entry.scope ?? '', entry.factKind, entry.key.trim()].join('\u0000')
  return [...entries].sort((left, right) => {
    const leftKey = key(left)
    const rightKey = key(right)
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}

/** Lifecycle: draft may be tested or dropped; testing may promote or drop; promoted/dropped end. */
const SOP_TRANSITIONS: Record<SopStatus, readonly SopStatus[]> = {
  draft: ['draft', 'testing', 'dropped'],
  testing: ['testing', 'promoted', 'dropped'],
  promoted: [],
  dropped: [],
}

const COMMON_PATCH_FIELDS = new Set([
  'privacy', 'app', 'scenario', 'taskType', 'entities', 'sourceSession', 'sourceTime',
  'displayTitle', 'sourceLabel', 'sourceSeqs', 'origin', 'tags', 'evidence', 'credentialRef', 'supersedes', 'body',
])

/** Fields `updateEntry` accepts for each type; anything else is a route bug. */
const PATCH_FIELDS: Record<MemoryType, ReadonlySet<string>> = {
  preference: new Set([...COMMON_PATCH_FIELDS, 'topic', 'value']),
  pitfall: new Set([...COMMON_PATCH_FIELDS, 'errorSignature', 'context', 'solution', 'appliesTo']),
  episodic: new Set([...COMMON_PATCH_FIELDS, 'summary', 'request', 'outcome', 'sopUsed', 'promotedTo']),
  fact: new Set([...COMMON_PATCH_FIELDS, 'factKind', 'key', 'statement', 'scope']),
  sop: new Set([...COMMON_PATCH_FIELDS, 'title', 'trigger', 'steps', 'tools', 'successCriteria']),
}

const ENTRY_TYPE_RANK: Record<MemoryType, number> = {
  preference: 0,
  pitfall: 1,
  fact: 2,
  episodic: 3,
  sop: 4,
}

/** Merge key for the three deduplicating surfaces; other types have none. */
function mergeKeyOf(entry: AnyMemoryEntry): string | undefined {
  switch (entry.type) {
    case 'preference':
      return `${entry.app ?? ''}\u0000${entry.topic.trim()}`
    case 'pitfall':
      return entry.errorSignature.trim().toLowerCase()
    case 'fact':
      return [entry.app ?? '', entry.scope ?? '', entry.factKind, entry.key.trim()].join('\u0000')
    default:
      return undefined
  }
}

/** Newest-first, then fixed type order and id. */
function compareListedEntries(left: ListedMemoryEntry, right: ListedMemoryEntry): number {
  const leftTime = left.updatedAt ?? left.createdAt
  const rightTime = right.updatedAt ?? right.createdAt
  if (leftTime !== rightTime) return leftTime < rightTime ? 1 : -1
  const type = ENTRY_TYPE_RANK[left.type] - ENTRY_TYPE_RANK[right.type]
  if (type !== 0) return type
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/** Short, non-secret line for the tombstone audit. */
function summarizeEntry(entry: AnyMemoryEntry): string {
  const value = entry.type === 'preference'
    ? entry.value
    : entry.type === 'pitfall'
      ? entry.solution
      : entry.type === 'fact'
        ? entry.statement
        : entry.type === 'episodic'
          ? entry.summary
          : entry.title
  const clean = value.replace(/\s+/gu, ' ').trim()
  return clean.length <= 200 ? clean : `${clean.slice(0, 199)}…`
}

/**
 * One personal memory root. All methods are async and write atomically; the
 * returned paths are `/`-separated and relative to the root.
 */
export class MemoryStore {
  private readonly root: string
  private readonly clock: () => Date

  constructor(root: string, options: MemoryStoreOptions = {}) {
    if (typeof root !== 'string' || root.trim() === '') {
      throw new MemoryStoreError('invalid-root', 'memory root must be a non-empty path')
    }
    this.root = root
    this.clock = options.now ?? ((): Date => new Date())
  }

  /** Absolute root this store writes under. */
  get memoryRoot(): string { return this.root }

  private now(): string { return this.clock().toISOString() }

  private absolute(relPath: string): string {
    return join(this.root, ...relPath.split('/'))
  }

  private async readDocument(relPath: string): Promise<ReadDocument> {
    const absolute = this.absolute(relPath)
    let text: string
    try {
      text = await readFile(absolute, 'utf8')
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
        return { exists: false, text: '', entries: [], issues: [] }
      }
      throw error
    }
    const parsed = parseMemoryEntries(text)
    return { exists: true, text, entries: parsed.entries, issues: parsed.issues }
  }

  /** A write must not silently repair or clobber a file that already has issues. */
  private assertWritable(doc: ReadDocument, relPath: string): void {
    if (doc.issues.length === 0) return
    throw new MemoryStoreError(
      'invalid-memory-file',
      `${relPath} has ${String(doc.issues.length)} parse issue(s): ${doc.issues[0]?.message ?? 'unknown'}`,
    )
  }

  private entriesOfType<T extends AnyMemoryEntry['type']>(
    doc: ReadDocument,
    type: T,
  ): Extract<AnyMemoryEntry, { type: T }>[] {
    return doc.entries.filter((entry): entry is Extract<AnyMemoryEntry, { type: T }> => entry.type === type)
  }

  private materialize(input: MemoryEntryInput): AnyMemoryEntry {
    const now = this.now()
    const base = {
      ...input,
      id: input.id ?? newMemoryId(),
      createdAt: input.createdAt ?? now,
      privacy: input.privacy ?? 'private',
    }
    const entry: AnyMemoryEntry = input.type === 'sop'
      ? {
        ...base,
        type: 'sop',
        slug: input.slug ?? slugifyTitle(input.title),
        status: input.status ?? 'draft',
        version: input.version ?? 1,
      } as Sop
      : (base as AnyMemoryEntry)
    assertValidMemoryEntry(entry)
    return entry
  }

  /**
   * Append one raw entry to the day document `记忆日志/YYYY-MM-DD.md`.
   *
   * The date comes from `options.date`, else the `YYYY-MM-DD` prefix of
   * `sourceTime`, else the store clock. The generated id is unique; an explicit
   * duplicate id in the same day document is refused.
   */
  async appendLog(input: MemoryEntryInput, options: AppendLogOptions = {}): Promise<AppendLogResult> {
    const entry = this.materialize(input)
    let date: string
    if (options.date !== undefined) {
      if (!isValidLogDate(options.date)) {
        throw new MemoryStoreError('invalid-log-date', `log date must be a real YYYY-MM-DD date, got ${JSON.stringify(options.date)}`)
      }
      date = options.date
    } else {
      const sourceDate = /^(\d{4}-\d{2}-\d{2})/u.exec(entry.sourceTime ?? '')?.[1]
      date = sourceDate !== undefined && isValidLogDate(sourceDate) ? sourceDate : localDateOf(this.clock())
    }
    const relPath = `${MEMORY_LOG_DIR}/${date}.md`
    const doc = await this.readDocument(relPath)
    this.assertWritable(doc, relPath)
    if (doc.entries.some(existing => existing.id === entry.id)) {
      throw new MemoryStoreError('duplicate-id', `memory id ${entry.id} already exists in ${relPath}`)
    }
    const header = `# 记忆日志 ${date}\n\n> 原始抽取与审计；按时间追加，不在此处编辑。`
    const content = doc.exists
      ? `${doc.text.replace(/\n+$/u, '')}\n\n${serializeMemoryEntry(entry)}`
      : `${header}\n\n${serializeMemoryEntry(entry)}`
    await writeFileAtomic(this.absolute(relPath), content)
    return { id: entry.id, date, path: relPath }
  }

  /**
   * Merge one preference by `app + topic`.
   *
   * - identical content is a no-op (no new id, no duplicate);
   * - a changed value replaces the current entry with a new id that records
   *   `supersedes`; the old value stays only in the daily log;
   * - same value with changed metadata updates the existing entry in place.
   */
  async upsertPreference(input: PreferenceInput): Promise<PreferenceUpsertResult> {
    const candidate = this.materialize(input) as Preference
    const doc = await this.readDocument(MEMORY_PREFERENCE_FILE)
    this.assertWritable(doc, MEMORY_PREFERENCE_FILE)
    const entries = this.entriesOfType(doc, 'preference')
    const index = entries.findIndex(entry => entry.app === candidate.app && entry.topic.trim() === candidate.topic.trim())
    if (index < 0) {
      entries.push(candidate)
      await writeFileAtomic(this.absolute(MEMORY_PREFERENCE_FILE), renderDocument(PREFERENCE_HEADER, sortPreferences(entries)))
      return { id: candidate.id, path: MEMORY_PREFERENCE_FILE, created: true }
    }

    const existing = entries[index] as Preference
    if (contentKey(existing) === contentKey(candidate)) {
      return { id: existing.id, path: MEMORY_PREFERENCE_FILE, created: false }
    }
    if (existing.value === candidate.value) {
      const merged = applyDefined(existing, candidate)
      merged.id = existing.id
      merged.createdAt = existing.createdAt
      merged.updatedAt = this.now()
      merged.supersedes = existing.supersedes
      assertValidMemoryEntry(merged)
      entries[index] = merged
      await writeFileAtomic(this.absolute(MEMORY_PREFERENCE_FILE), renderDocument(PREFERENCE_HEADER, sortPreferences(entries)))
      return { id: merged.id, path: MEMORY_PREFERENCE_FILE, created: false }
    }

    const replacement = applyDefined(candidate, candidate)
    replacement.supersedes = existing.id
    replacement.updatedAt = this.now()
    entries[index] = replacement
    await writeFileAtomic(this.absolute(MEMORY_PREFERENCE_FILE), renderDocument(PREFERENCE_HEADER, sortPreferences(entries)))
    return { id: replacement.id, path: MEMORY_PREFERENCE_FILE, created: false, superseded: existing.id }
  }

  /**
   * Merge one pitfall by `errorSignature` (trimmed, case-insensitive).
   *
   * A repeated pitfall never duplicates: the existing entry keeps its id, the
   * latest solution/context wins, `appliesTo`/`evidence`/`tags` are unioned, and
   * the stricter privacy label survives.
   */
  async upsertPitfall(input: PitfallInput): Promise<PitfallUpsertResult> {
    const candidate = this.materialize(input) as Pitfall
    const doc = await this.readDocument(MEMORY_PITFALL_FILE)
    this.assertWritable(doc, MEMORY_PITFALL_FILE)
    const entries = this.entriesOfType(doc, 'pitfall')
    const signature = (entry: Pitfall): string => entry.errorSignature.trim().toLowerCase()
    const index = entries.findIndex(entry => signature(entry) === signature(candidate))
    if (index < 0) {
      entries.push(candidate)
      await writeFileAtomic(this.absolute(MEMORY_PITFALL_FILE), renderDocument(PITFALL_HEADER, sortPitfalls(entries)))
      return { id: candidate.id, path: MEMORY_PITFALL_FILE, created: true, merged: false }
    }

    const existing = entries[index] as Pitfall
    const merged = applyDefined(existing, candidate)
    merged.id = existing.id
    merged.createdAt = existing.createdAt
    merged.updatedAt = this.now()
    merged.supersedes = existing.supersedes
    merged.privacy = stricterPrivacy(existing.privacy, candidate.privacy)
    merged.credentialRef = candidate.credentialRef ?? existing.credentialRef
    merged.appliesTo = unionSorted(existing.appliesTo, candidate.appliesTo)
    merged.evidence = unionSorted(existing.evidence, candidate.evidence)
    merged.tags = unionSorted(existing.tags, candidate.tags)
    assertValidMemoryEntry(merged)
    if (contentKey(merged) === contentKey(existing)) {
      return { id: existing.id, path: MEMORY_PITFALL_FILE, created: false, merged: true }
    }
    entries[index] = merged
    await writeFileAtomic(this.absolute(MEMORY_PITFALL_FILE), renderDocument(PITFALL_HEADER, sortPitfalls(entries)))
    return { id: merged.id, path: MEMORY_PITFALL_FILE, created: false, merged: true }
  }

  /**
   * Merge one fact by `app + scope + factKind + key`.
   *
   * Same statement updates the existing entry in place. A different statement
   * for the same key replaces it and reports `conflict: true` unless the caller
   * explicitly named the entry to supersede; either way only one current entry
   * for that key remains and `supersedes` records the old id.
   */
  async upsertFact(input: FactInput): Promise<FactUpsertResult> {
    const candidate = this.materialize(input) as Fact
    const doc = await this.readDocument(MEMORY_FACT_FILE)
    this.assertWritable(doc, MEMORY_FACT_FILE)
    const entries = this.entriesOfType(doc, 'fact')
    const factKey = (entry: Fact): string =>
      [entry.app ?? '', entry.scope ?? '', entry.factKind, entry.key.trim()].join('\u0000')

    const explicitIndex = candidate.supersedes === undefined
      ? -1
      : entries.findIndex(entry => entry.id === candidate.supersedes)
    if (explicitIndex >= 0) {
      const superseded = entries[explicitIndex] as Fact
      entries.splice(explicitIndex, 1)
      const replacement = applyDefined(candidate, candidate)
      replacement.supersedes = superseded.id
      replacement.updatedAt = this.now()
      entries.push(replacement)
      await writeFileAtomic(this.absolute(MEMORY_FACT_FILE), renderFactDocument(sortFacts(entries)))
      return {
        id: replacement.id,
        path: MEMORY_FACT_FILE,
        created: false,
        superseded: superseded.id,
        conflict: false,
      }
    }

    const index = entries.findIndex(entry => factKey(entry) === factKey(candidate))
    if (index < 0) {
      entries.push(candidate)
      await writeFileAtomic(this.absolute(MEMORY_FACT_FILE), renderFactDocument(sortFacts(entries)))
      return { id: candidate.id, path: MEMORY_FACT_FILE, created: true, conflict: false }
    }

    const existing = entries[index] as Fact
    if (existing.statement.trim() === candidate.statement.trim()) {
      const merged = applyDefined(existing, candidate)
      merged.id = existing.id
      merged.createdAt = existing.createdAt
      merged.updatedAt = this.now()
      merged.supersedes = existing.supersedes
      assertValidMemoryEntry(merged)
      if (contentKey(merged) === contentKey(existing)) {
        return { id: existing.id, path: MEMORY_FACT_FILE, created: false, conflict: false }
      }
      entries[index] = merged
      await writeFileAtomic(this.absolute(MEMORY_FACT_FILE), renderFactDocument(sortFacts(entries)))
      return { id: merged.id, path: MEMORY_FACT_FILE, created: false, conflict: false }
    }

    const replacement = applyDefined(candidate, candidate)
    replacement.supersedes = existing.id
    replacement.updatedAt = this.now()
    entries[index] = replacement
    await writeFileAtomic(this.absolute(MEMORY_FACT_FILE), renderFactDocument(sortFacts(entries)))
    return {
      id: replacement.id,
      path: MEMORY_FACT_FILE,
      created: false,
      superseded: existing.id,
      conflict: true,
    }
  }

  /** Create a new SOP file (`draft`, version 1). An existing slug is refused. */
  async writeSop(input: SopInput): Promise<SopWriteResult> {
    const candidate = this.materialize(input) as Sop
    const relPath = `${MEMORY_SOP_DIR}/${candidate.slug}.md`
    if (await this.pathExists(relPath)) {
      throw new MemoryStoreError('sop-exists', `SOP ${candidate.slug} already exists; use updateSop to revise it`)
    }
    await writeFileAtomic(this.absolute(relPath), `# ${candidate.title}\n\n${serializeMemoryEntry(candidate)}`)
    return { sop: candidate, path: relPath }
  }

  /**
   * Revise one SOP, incrementing its version.
   *
   * `draft → testing | dropped`, `testing → promoted | dropped`; same-status
   * edits are revisions. `promoted`/`dropped` are terminal.
   */
  async updateSop(slug: string, patch: SopPatch): Promise<SopUpdateResult> {
    if (!isSafeMemorySlug(slug)) {
      throw new MemoryStoreError('unsafe-path', `SOP slug ${JSON.stringify(slug)} is not a safe file name`)
    }
    const relPath = `${MEMORY_SOP_DIR}/${slug}.md`
    const doc = await this.readDocument(relPath)
    if (!doc.exists) throw new MemoryStoreError('sop-not-found', `SOP ${slug} does not exist`)
    this.assertWritable(doc, relPath)
    const existing = this.entriesOfType(doc, 'sop')[0]
    if (existing === undefined) {
      throw new MemoryStoreError('invalid-memory-file', `${relPath} does not contain a SOP entry`)
    }
    if (SOP_TRANSITIONS[existing.status].length === 0) {
      throw new MemoryStoreError('sop-terminal', `SOP ${slug} is ${existing.status} and can no longer be updated`)
    }
    const nextStatus = patch.status ?? existing.status
    if (!isSopStatus(nextStatus) || !SOP_TRANSITIONS[existing.status].includes(nextStatus)) {
      throw new MemoryStoreError(
        'invalid-status-transition',
        `SOP ${slug} cannot move from ${existing.status} to ${String(patch.status)}`,
      )
    }

    const candidate: Sop = {
      ...applyDefined(existing, patch),
      status: nextStatus,
      version: existing.version + 1,
      updatedAt: this.now(),
    }
    assertValidMemoryEntry(candidate)
    await writeFileAtomic(this.absolute(relPath), `# ${candidate.title}\n\n${serializeMemoryEntry(candidate)}`)
    return { sop: candidate, path: relPath }
  }

  /** Delete one SOP file (the promote-to-skill step calls this). Missing is false, not an error. */
  async deleteSop(slug: string): Promise<boolean> {
    if (!isSafeMemorySlug(slug)) {
      throw new MemoryStoreError('unsafe-path', `SOP slug ${JSON.stringify(slug)} is not a safe file name`)
    }
    const relPath = `${MEMORY_SOP_DIR}/${slug}.md`
    if (!(await this.pathExists(relPath))) return false
    await rm(this.absolute(relPath), { force: true })
    return true
  }

  /** Current SOPs, sorted by slug. A corrupt SOP file is an error, not silently skipped. */
  async listSops(): Promise<Sop[]> {
    const { sops, issues } = await this.readSops()
    if (issues.length > 0) {
      throw new MemoryStoreError('invalid-memory-file', `SOP directory has ${String(issues.length)} parse issue(s): ${issues[0]?.message ?? 'unknown'}`)
    }
    return sops
  }

  /**
   * Read the current memory index: aggregate files, SOPs and daily-log counts.
   *
   * Unlike a write, an index read is tolerant: entries that fail validation are
   * reported in `issues` instead of blocking the rest of the snapshot.
   */
  async readMemoryIndex(): Promise<MemoryIndex> {
    const [preferenceDoc, pitfallDoc, factDoc, sopResult] = await Promise.all([
      this.readDocument(MEMORY_PREFERENCE_FILE),
      this.readDocument(MEMORY_PITFALL_FILE),
      this.readDocument(MEMORY_FACT_FILE),
      this.readSops(),
    ])
    const issues: MemoryValidationIssue[] = [
      ...preferenceDoc.issues,
      ...pitfallDoc.issues,
      ...factDoc.issues,
      ...sopResult.issues,
    ]
    return {
      root: this.root,
      preferences: sortPreferences(this.entriesOfType(preferenceDoc, 'preference')),
      pitfalls: sortPitfalls(this.entriesOfType(pitfallDoc, 'pitfall')),
      facts: sortFacts(this.entriesOfType(factDoc, 'fact')),
      sops: sopResult.sops,
      logs: await this.listLogs(),
      issues,
    }
  }


  /**
   * List every current memory entry across the five surfaces.
   *
   * Aggregates (`偏好`/`踩坑`/`事实`), daily logs (`记忆日志/`), and SOP files are
   * read directly; entries are deduped by id (first occurrence wins) and sorted
   * newest-first by `updatedAt ?? createdAt`, then by type and id. `path` is the
   * document relative to the memory root. Parse issues are tolerated here so one
   * bad file cannot blank the memory page; writes still refuse them.
   */
  async listEntries(): Promise<ListedMemoryEntry[]> {
    const found: ListedMemoryEntry[] = []
    for (const [path, kind] of [
      [MEMORY_PREFERENCE_FILE, 'preference'],
      [MEMORY_PITFALL_FILE, 'pitfall'],
      [MEMORY_FACT_FILE, 'fact'],
    ] as const) {
      const doc = await this.readDocument(path)
      for (const entry of doc.entries) found.push({ ...entry, path })
      void kind
    }

    const logs = await this.listLogs()
    for (const log of [...logs].sort((left, right) => (left.date < right.date ? 1 : left.date > right.date ? -1 : 0))) {
      const doc = await this.readDocument(log.path)
      for (const entry of doc.entries) found.push({ ...entry, path: log.path })
    }

    const sops = await this.readSops()
    for (const sop of sops.sops) {
      found.push({ ...sop, path: `${MEMORY_SOP_DIR}/${sop.slug}.md` })
    }

    const seen = new Set<string>()
    const unique = found.filter(entry => {
      if (seen.has(entry.id)) return false
      seen.add(entry.id)
      return true
    })
    return unique.sort(compareListedEntries)
  }

  /** Read one entry (with its document path) by exact id. */
  async getEntry(id: string): Promise<ListedMemoryEntry | undefined> {
    if (typeof id !== 'string' || id.trim() === '') return undefined
    return (await this.listEntries()).find(entry => entry.id === id)
  }

  /**
   * Correct one existing entry in place.
   *
   * The id, type and createdAt are preserved; the document path, SOP slug and
   * version, and SOP lifecycle status are not patchable. Merge-key fields may
   * change, but a new key must not collide with another current entry. Privacy
   * changes go through the same validation as writes, so `secret` still needs a
   * `credentialRef`.
   *
   * @returns the corrected entry plus its document path.
   */
  async updateEntry(id: string, patch: MemoryEntryPatch): Promise<ListedMemoryEntry> {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new MemoryStoreError('invalid-patch', 'patch must be an object')
    }
    const located = await this.findEntry(id)
    if (located === undefined) {
      throw new MemoryStoreError('not-found', `memory entry ${id} does not exist`)
    }
    this.assertWritable(located.doc, located.path)

    const allowed = PATCH_FIELDS[located.entry.type]
    const unknown = Object.keys(patch).filter(key => !allowed.has(key))
    if (unknown.length > 0) {
      throw new MemoryStoreError(
        'invalid-patch',
        `fields ${unknown.join(', ')} cannot be changed on a ${located.entry.type} entry`,
      )
    }
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as MemoryEntryPatch
    if (Object.keys(defined).length === 0) return { ...located.entry, path: located.path }

    const merged = {
      ...located.entry,
      ...defined,
      id: located.entry.id,
      type: located.entry.type,
      createdAt: located.entry.createdAt,
      updatedAt: this.now(),
    } as AnyMemoryEntry
    assertValidMemoryEntry(merged)

    const entries = located.doc.entries.map(entry => (entry.id === id ? merged : entry))
    this.assertMergeKeyUnique(merged, entries)
    await this.writeLocatedDocument(located, entries)
    return { ...merged, path: located.path }
  }

  /**
   * Forget one entry: append a tombstone/audit record, then remove it from its
   * document (or delete the SOP file). The guardian's next dream treats the
   * tombstone as a durable user deletion and must not re-extract it.
   *
   * A missing id is a no-op result, not an error.
   */
  async forgetEntry(id: string): Promise<ForgetEntryResult> {
    const located = await this.findEntry(id)
    if (located === undefined) return { id, removed: false, tombstoned: false }
    this.assertWritable(located.doc, located.path)

    await this.appendTombstone(located.entry, located.path)
    if (located.kind === 'sop') {
      await rm(this.absolute(located.path), { force: true })
    } else {
      const remaining = located.doc.entries.filter(entry => entry.id !== id)
      await this.writeLocatedDocument(located, remaining)
    }
    return { id, removed: true, tombstoned: true }
  }

  /** Locate one entry and the document that holds it. */
  private async findEntry(id: string): Promise<LocatedEntry | undefined> {
    if (typeof id !== 'string' || id.trim() === '') return undefined
    for (const [path, kind] of [
      [MEMORY_PREFERENCE_FILE, 'preference'],
      [MEMORY_PITFALL_FILE, 'pitfall'],
      [MEMORY_FACT_FILE, 'fact'],
    ] as const) {
      const doc = await this.readDocument(path)
      const entry = doc.entries.find(candidate => candidate.id === id)
      if (entry !== undefined) return { entry, path, kind, doc }
    }

    const logs = await this.listLogs()
    for (const log of [...logs].sort((left, right) => (left.date < right.date ? 1 : left.date > right.date ? -1 : 0))) {
      const doc = await this.readDocument(log.path)
      const entry = doc.entries.find(candidate => candidate.id === id)
      if (entry !== undefined) return { entry, path: log.path, kind: 'log', doc }
    }

    const directory = this.absolute(MEMORY_SOP_DIR)
    let names: string[]
    try {
      names = (await readdir(directory, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        .map(entry => entry.name)
        .sort()
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) return undefined
      throw error
    }
    for (const name of names) {
      const slug = name.slice(0, -3)
      if (!isSafeMemorySlug(slug)) continue
      const path = `${MEMORY_SOP_DIR}/${name}`
      const doc = await this.readDocument(path)
      const entry = doc.entries.find(candidate => candidate.id === id)
      if (entry !== undefined) return { entry, path, kind: 'sop', doc }
    }
    return undefined
  }

  /** Reject a correction that would create two current entries with one merge key. */
  private assertMergeKeyUnique(candidate: AnyMemoryEntry, entries: readonly AnyMemoryEntry[]): void {
    const key = mergeKeyOf(candidate)
    if (key === undefined) return
    const duplicate = entries.find(entry => entry.id !== candidate.id && mergeKeyOf(entry) === key)
    if (duplicate !== undefined) {
      throw new MemoryStoreError(
        'duplicate-key',
        `changing this entry would collide with ${duplicate.id} on the same merge key`,
      )
    }
  }

  /** Re-render the exact document shape a located entry came from. */
  private async writeLocatedDocument(located: LocatedEntry, entries: readonly AnyMemoryEntry[]): Promise<void> {
    if (located.kind === 'sop') {
      const sop = entries.find(entry => entry.type === 'sop') as Sop | undefined
      if (sop === undefined) throw new MemoryStoreError('invalid-memory-file', `${located.path} no longer contains a SOP`)
      await writeFileAtomic(this.absolute(located.path), `# ${sop.title}\n\n${serializeMemoryEntry(sop)}`)
      return
    }

    const header = located.doc.text.split(MEMORY_ENTRY_MARKER)[0].replace(/\n+$/u, '')
    if (located.kind === 'preference') {
      await writeFileAtomic(
        this.absolute(located.path),
        renderDocument(header || PREFERENCE_HEADER, sortPreferences(entries as Preference[])),
      )
      return
    }
    if (located.kind === 'pitfall') {
      await writeFileAtomic(
        this.absolute(located.path),
        renderDocument(header || PITFALL_HEADER, sortPitfalls(entries as Pitfall[])),
      )
      return
    }
    if (located.kind === 'fact') {
      await writeFileAtomic(this.absolute(located.path), renderFactDocument(sortFacts(entries as Fact[])))
      return
    }
    // Daily log: keep the original order and header; removal leaves the rest intact.
    const fallback = `# 记忆日志\n\n> 原始抽取与审计；按时间追加，不在此处编辑。`
    await writeFileAtomic(this.absolute(located.path), renderDocument(header || fallback, entries))
  }

  /** Append one human-auditable tombstone; never includes body or credential values. */
  private async appendTombstone(entry: AnyMemoryEntry, path: string): Promise<void> {
    const doc = await this.readDocument(MEMORY_FORGET_FILE)
    const header = '# 遗忘记录\n\n> 用户主动忘记的记忆；守护会话在 dream 时尊重删除，不重新抽回。'
    const record = stringifySimpleYaml({
      id: entry.id,
      type: entry.type,
      path,
      forgottenAt: this.now(),
      ...(entry.sourceLabel === undefined ? {} : { sourceLabel: entry.sourceLabel }),
      summary: summarizeEntry(entry),
    }).trimEnd()
    const block = `${MEMORY_FORGET_MARKER}\n---\n${record}\n---\n`
    const content = doc.exists
      ? `${doc.text.replace(/\n+$/u, '')}\n\n${block}`
      : `${header}\n\n${block}`
    await writeFileAtomic(this.absolute(MEMORY_FORGET_FILE), content)
  }

  private async readSops(): Promise<{ sops: Sop[]; issues: MemoryValidationIssue[] }> {
    const directory = this.absolute(MEMORY_SOP_DIR)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) return { sops: [], issues: [] }
      throw error
    }
    const sops: Sop[] = []
    const issues: MemoryValidationIssue[] = []
    const names = entries
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md') && isSafeMemorySlug(entry.name.slice(0, -3)))
      .map(entry => entry.name)
      .sort()
    for (const name of names) {
      const relPath = `${MEMORY_SOP_DIR}/${name}`
      const doc = await this.readDocument(relPath)
      issues.push(...doc.issues)
      const sop = this.entriesOfType(doc, 'sop')[0]
      if (sop !== undefined) sops.push(sop)
      else issues.push({ code: 'invalid-entry', message: `${relPath} does not contain a SOP entry` })
    }
    return { sops: sops.sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0)), issues }
  }

  private async listLogs(): Promise<MemoryLogSummary[]> {
    const directory = this.absolute(MEMORY_LOG_DIR)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) return []
      throw error
    }
    const logs: MemoryLogSummary[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const match = /^(\d{4}-\d{2}-\d{2})\.md$/u.exec(entry.name)
      if (match === null || !isValidLogDate(match[1] as string)) continue
      const relPath = `${MEMORY_LOG_DIR}/${entry.name}`
      const text = await readFile(this.absolute(relPath), 'utf8')
      logs.push({ date: match[1] as string, path: relPath, entries: text.split('<!-- memory:entry -->').length - 1 })
    }
    logs.sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0))
    return logs
  }

  private async pathExists(relPath: string): Promise<boolean> {
    try {
      await stat(this.absolute(relPath))
      return true
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) return false
      throw error
    }
  }
}
