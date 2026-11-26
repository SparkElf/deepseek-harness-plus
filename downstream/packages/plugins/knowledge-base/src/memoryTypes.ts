/**
 * The five-type personal memory model and its on-disk front matter.
 *
 * The design settled on exactly five memory types (design §15). Anything that
 * looks like another type is a field or an operation instead:
 *
 * - a decision is an `episodic` entry or a `fact`;
 * - a procedure is a `sop` (or a `pitfall` when it is a failure story);
 * - an entity is metadata (`entities`), a correction is a `supersedes` write;
 * - a redline is an `authority` level, not a memory type.
 *
 * Privacy is a separate axis shared by all five types:
 * `normal | private | sensitive | secret`. `secret` is not "more private"; it
 * means the memory contains a `credentialRef` and never the credential value
 * itself. Personal memory defaults to `private`.
 *
 * Files use the same tiny YAML dialect as `memoryBindings.ts` (scalars, quoted
 * strings, inline arrays, `#` comments), and each entry is delimited by
 * {@link MEMORY_ENTRY_MARKER} so a daily log or aggregate file can hold many
 * entries without a YAML multi-document parser.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-types
 */

import { randomUUID } from 'node:crypto'
import { formatYamlScalar, parseSimpleYaml, stringifySimpleYaml, type YamlRecord } from './memoryBindings.ts'

/** The five memory types. No other type is added; see the design §15.1. */
export const MEMORY_TYPES = ['preference', 'pitfall', 'episodic', 'fact', 'sop'] as const
export type MemoryType = typeof MEMORY_TYPES[number]

/** The privacy axis shared by every memory type (design §15.2). */
export const PRIVACY_VALUES = ['normal', 'private', 'sensitive', 'secret'] as const
export type Privacy = typeof PRIVACY_VALUES[number]

/** What kind of explicit statement a `fact` records. */
export const FACT_KINDS = ['requirement', 'decision', 'clarification'] as const
export type FactKind = typeof FACT_KINDS[number]

/** SOP lifecycle. `promoted` and `dropped` are terminal. */
export const SOP_STATUSES = ['draft', 'testing', 'promoted', 'dropped'] as const
export type SopStatus = typeof SOP_STATUSES[number]

/** Application id is an open string; the design lists suggested values only. */
export type AppId = string

/** Whether a memory entry was extracted automatically or explicitly requested by the user. */
export const MEMORY_ORIGINS = ['auto', 'explicit'] as const
export type MemoryOrigin = typeof MEMORY_ORIGINS[number]

/** Separator used to display a source snapshot without exposing a raw session id. */
export const MEMORY_SOURCE_LABEL_FALLBACK = '历史会话'

/** Marker that starts one entry inside a multi-entry memory document. */
export const MEMORY_ENTRY_MARKER = '<!-- memory:entry -->'

/** Fields every memory entry carries. */
export interface MemoryEntry {
  id: string
  type: MemoryType
  /** `private` is the personal-memory default; caller may narrow/raise it. */
  privacy: Privacy
  createdAt: string
  updatedAt?: string
  app?: AppId
  scenario?: string
  taskType?: string
  entities?: string[]
  sourceSession?: string
  /** When the remembered thing happened (not necessarily when it was written). */
  sourceTime?: string
  /** Short user-facing title (<= 20 chars); never a tool name, path or session id. */
  displayTitle?: string
  /** Human-readable source snapshot (session title / app / scenario); never a session id. */
  sourceLabel?: string
  /** Evidence event positions inside the source session, when known. */
  sourceSeqs?: number[]
  /** `auto` for extracted memory, `explicit` when the user asked to remember it. */
  origin?: MemoryOrigin
  tags?: string[]
  /** Paths / session ids / other evidence pointers; never a secret value. */
  evidence?: string[]
  /** For `privacy: secret`: which credential holds the value, and for what. */
  credentialRef?: string
  /** Id of the entry this one replaces. */
  supersedes?: string
  /** Optional free body after the front matter. */
  body?: string
}

/** A soft habit, style or default value that newer preferences replace. */
export interface Preference extends MemoryEntry {
  type: 'preference'
  /** Merge key inside one app: one current value per topic. */
  topic: string
  value: string
}

/** A real failure with its context, fix and applicability. */
export interface Pitfall extends MemoryEntry {
  type: 'pitfall'
  /** Dedupe key; repeated writes with the same signature merge. */
  errorSignature: string
  context: string
  solution: string
  appliesTo?: string[]
}

/** What happened in a session: request, outcome and what it graduated into. */
export interface Episodic extends MemoryEntry {
  type: 'episodic'
  summary: string
  request?: string
  outcome?: string
  sopUsed?: string[]
  promotedTo?: string[]
}

/** Something the user explicitly required, decided or clarified. */
export interface Fact extends MemoryEntry {
  type: 'fact'
  factKind: FactKind
  /** Merge key inside one app/scope/factKind. */
  key: string
  statement: string
  /** Free grouping label such as `驾驶舱` or `权限`. */
  scope?: string
}

/** A reusable how-to draft; promoted into a skill and then deleted. */
export interface Sop extends MemoryEntry {
  type: 'sop'
  slug: string
  title: string
  status: SopStatus
  /** Starts at 1 and increments on every update. */
  version: number
  trigger: string
  steps: string[]
  /** Tools and parameters as human-readable strings (e.g. `kb_search(limit=5)`). */
  tools?: string[]
  successCriteria?: string[]
  /** Where the promoted skill was written (skill name/path refs). */
  promotedTo?: string[]
}

/** Any of the five concrete memory entries. */
export type AnyMemoryEntry = Preference | Pitfall | Episodic | Fact | Sop

/** Metadata accepted by a store write for every type. */
export interface MemoryMetadataInput {
  id?: string
  /** Omitted -> `private` (personal-memory default). */
  privacy?: Privacy
  createdAt?: string
  updatedAt?: string
  app?: AppId
  scenario?: string
  taskType?: string
  entities?: string[]
  sourceSession?: string
  sourceTime?: string
  displayTitle?: string
  sourceLabel?: string
  sourceSeqs?: number[]
  origin?: MemoryOrigin
  tags?: string[]
  evidence?: string[]
  credentialRef?: string
  supersedes?: string
  body?: string
}

export interface PreferenceInput extends MemoryMetadataInput { type: 'preference'; topic: string; value: string }
export interface PitfallInput extends MemoryMetadataInput {
  type: 'pitfall'; errorSignature: string; context: string; solution: string; appliesTo?: string[]
}
export interface EpisodicInput extends MemoryMetadataInput {
  type: 'episodic'; summary: string; request?: string; outcome?: string; sopUsed?: string[]; promotedTo?: string[]
}
export interface FactInput extends MemoryMetadataInput {
  type: 'fact'; factKind: FactKind; key: string; statement: string; scope?: string
}
export interface SopInput extends MemoryMetadataInput {
  type: 'sop'
  slug?: string
  title: string
  status?: SopStatus
  version?: number
  trigger: string
  steps: string[]
  tools?: string[]
  successCriteria?: string[]
  promotedTo?: string[]
}

/** Any input accepted by `MemoryStore` write methods. */
export type MemoryEntryInput = PreferenceInput | PitfallInput | EpisodicInput | FactInput | SopInput

/** One validation problem; `field` names the offending front-matter key. */
export interface MemoryValidationIssue {
  code:
    | 'invalid-entry'
    | 'invalid-value'
    | 'missing-field'
    | 'secret-value'
    | 'secret-requires-credential-ref'
    | 'unsafe-slug'
  message: string
  field?: string
}

/** Thrown by validation and by the store before anything is written. */
export class MemoryValidationError extends Error {
  readonly issues: MemoryValidationIssue[]

  constructor(issues: MemoryValidationIssue[]) {
    super(issues.map(issue => issue.message).join('; '))
    this.name = 'MemoryValidationError'
    this.issues = issues
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isMemoryType = (value: unknown): value is MemoryType =>
  typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value)

export const isPrivacy = (value: unknown): value is Privacy =>
  typeof value === 'string' && (PRIVACY_VALUES as readonly string[]).includes(value)

export const isFactKind = (value: unknown): value is FactKind =>
  typeof value === 'string' && (FACT_KINDS as readonly string[]).includes(value)

export const isSopStatus = (value: unknown): value is SopStatus =>
  typeof value === 'string' && (SOP_STATUSES as readonly string[]).includes(value)

export const isMemoryOrigin = (value: unknown): value is MemoryOrigin =>
  typeof value === 'string' && (MEMORY_ORIGINS as readonly string[]).includes(value)

/** A slug is one safe file name (Unicode allowed, no separators or hidden names). */
export function isSafeMemorySlug(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value === '' || value !== value.trim() || value.length > 80) return false
  if (value === '.' || value === '..' || value.startsWith('.')) return false
  return !/[\u0000-\u001f\u007f/\\]/u.test(value)
}

/**
 * High-confidence plaintext credential shapes.
 *
 * The patterns deliberately require a token-like value (not just the word
 * "password") so a legitimate memory such as "password: 必须定期更换" is not
 * rejected. A value that matches these must live in the credential manager and
 * be referenced through `credentialRef`.
 */
const PLAINTEXT_SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{12,}/u,
  /gh[pousr]_[A-Za-z0-9]{20,}/u,
  /AKIA[0-9A-Z]{16}/u,
  /xox[baprs]-[A-Za-z0-9-]{10,}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*[A-Za-z0-9_\-./+]{8,}/iu,
  /:\/\/[^/\s:@]+:[^/\s@]+@/u,
]

/** Return the field path holding a secret-like value, when one is found. */
function findPlaintextSecret(value: unknown, path = ''): string | undefined {
  if (typeof value === 'string') {
    return PLAINTEXT_SECRET_PATTERNS.some(pattern => pattern.test(value)) ? (path === '' ? 'value' : path) : undefined
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findPlaintextSecret(item, `${path}[${String(index)}]`)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      const found = findPlaintextSecret(item, path === '' ? key : `${path}.${key}`)
      if (found !== undefined) return found
    }
  }
  return undefined
}

const issue = (
  code: MemoryValidationIssue['code'],
  message: string,
  field?: string,
): MemoryValidationIssue => (field === undefined ? { code, message } : { code, message, field })

/**
 * Validate one complete memory entry (after the store has filled id/defaults).
 *
 * Unknown extra fields are tolerated so a newer writer can add bookkeeping, but
 * an invalid enum, missing required field, unsafe slug or plaintext secret is
 * always an error.
 */
export function validateMemoryEntry(value: unknown): MemoryValidationIssue[] {
  const issues: MemoryValidationIssue[] = []
  if (!isRecord(value)) return [issue('invalid-entry', 'memory entry must be an object')]
  if (!isMemoryType(value.type)) {
    return [issue('invalid-value', `type must be one of ${MEMORY_TYPES.join(', ')}`, 'type')]
  }
  const type = value.type
  const requireString = (field: string): void => {
    const fieldValue = value[field]
    if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
      issues.push(issue('missing-field', `${type} requires a non-empty "${field}"`, field))
    }
  }
  const optionalStringArray = (field: string): void => {
    const fieldValue = value[field]
    if (fieldValue === undefined) return
    if (!Array.isArray(fieldValue) || fieldValue.some(item => typeof item !== 'string' || item.trim() === '')) {
      issues.push(issue('invalid-value', `"${field}" must be an array of non-empty strings`, field))
    }
  }

  requireString('id')
  requireString('createdAt')
  if (value.privacy !== undefined && !isPrivacy(value.privacy)) {
    issues.push(issue('invalid-value', `privacy must be one of ${PRIVACY_VALUES.join(', ')}`, 'privacy'))
  }
  for (const field of [
    'app', 'scenario', 'taskType', 'sourceSession', 'sourceTime', 'displayTitle', 'sourceLabel',
    'credentialRef', 'supersedes', 'body',
  ]) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      issues.push(issue('invalid-value', `"${field}" must be a string`, field))
    }
  }
  for (const field of ['entities', 'tags', 'evidence']) optionalStringArray(field)
  if (value.sourceSeqs !== undefined) {
    if (!Array.isArray(value.sourceSeqs)
      || value.sourceSeqs.some(item => typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)) {
      issues.push(issue('invalid-value', '"sourceSeqs" must be an array of non-negative safe integers', 'sourceSeqs'))
    }
  }
  if (value.origin !== undefined && !isMemoryOrigin(value.origin)) {
    issues.push(issue('invalid-value', `origin must be one of ${MEMORY_ORIGINS.join(', ')}`, 'origin'))
  }

  switch (type) {
    case 'preference':
      requireString('topic')
      requireString('value')
      break
    case 'pitfall':
      requireString('errorSignature')
      requireString('context')
      requireString('solution')
      optionalStringArray('appliesTo')
      break
    case 'episodic':
      requireString('summary')
      for (const field of ['request', 'outcome']) {
        if (value[field] !== undefined && typeof value[field] !== 'string') {
          issues.push(issue('invalid-value', `"${field}" must be a string`, field))
        }
      }
      for (const field of ['sopUsed', 'promotedTo']) optionalStringArray(field)
      break
    case 'fact':
      if (!isFactKind(value.factKind)) {
        issues.push(issue('invalid-value', `factKind must be one of ${FACT_KINDS.join(', ')}`, 'factKind'))
      }
      requireString('key')
      requireString('statement')
      if (value.scope !== undefined && typeof value.scope !== 'string') {
        issues.push(issue('invalid-value', '"scope" must be a string', 'scope'))
      }
      break
    case 'sop':
      if (!isSafeMemorySlug(value.slug)) {
        issues.push(issue('unsafe-slug', '"slug" must be one safe file name (no separators, no leading dot)', 'slug'))
      }
      requireString('title')
      requireString('trigger')
      if (!isSopStatus(value.status)) {
        issues.push(issue('invalid-value', `status must be one of ${SOP_STATUSES.join(', ')}`, 'status'))
      }
      if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) {
        issues.push(issue('invalid-value', '"version" must be a positive integer', 'version'))
      }
      if (!Array.isArray(value.steps) || value.steps.length === 0
        || value.steps.some(step => typeof step !== 'string' || step.trim() === '')) {
        issues.push(issue('missing-field', 'sop requires a non-empty "steps" array', 'steps'))
      }
      optionalStringArray('tools')
      optionalStringArray('successCriteria')
      optionalStringArray('promotedTo')
      break
  }

  if (value.privacy === 'secret') {
    const reference = value.credentialRef
    if (typeof reference !== 'string' || reference.trim() === '') {
      issues.push(issue(
        'secret-requires-credential-ref',
        'privacy "secret" must reference a credential through "credentialRef"; never store the value',
        'credentialRef',
      ))
    } else if (/\s/u.test(reference)) {
      issues.push(issue('invalid-value', '"credentialRef" must not contain whitespace', 'credentialRef'))
    }
  }

  const secretField = findPlaintextSecret(value)
  if (secretField !== undefined) {
    issues.push(issue(
      'secret-value',
      `plaintext secret-like value found in "${secretField}"; store a credentialRef instead`,
      secretField,
    ))
  }

  return issues
}

/** Assert a complete entry, throwing one aggregated {@link MemoryValidationError}. */
export function assertValidMemoryEntry(value: unknown): asserts value is AnyMemoryEntry {
  const issues = validateMemoryEntry(value)
  if (issues.length > 0) throw new MemoryValidationError(issues)
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

const readStringArray = (record: Record<string, unknown>, key: string): string[] | undefined => {
  const value = record[key]
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return items.length > 0 ? items : undefined
}

const readNumberArray = (record: Record<string, unknown>, key: string): number[] | undefined => {
  const value = record[key]
  if (!Array.isArray(value)) return undefined
  const items: number[] = []
  for (const item of value) {
    if (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0) {
      items.push(item)
    } else if (typeof item === 'string' && /^\d+$/u.test(item.trim())) {
      // The simple YAML reader returns a scalar array as strings; a seq list is numeric.
      const parsed = Number(item.trim())
      if (Number.isSafeInteger(parsed)) items.push(parsed)
    }
  }
  return items.length > 0 ? items : undefined
}

const readVersion = (record: Record<string, unknown>): number | undefined => {
  const value = record.version
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) return Number(value.trim())
  return undefined
}

/** Front matter for one entry, in a stable key order. */
function entryToRecord(entry: AnyMemoryEntry): YamlRecord {
  const record: YamlRecord = {
    id: entry.id,
    type: entry.type,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    privacy: entry.privacy,
    app: entry.app,
    scenario: entry.scenario,
    taskType: entry.taskType,
    entities: entry.entities,
    sourceSession: entry.sourceSession,
    sourceTime: entry.sourceTime,
    displayTitle: entry.displayTitle,
    sourceLabel: entry.sourceLabel,
    sourceSeqs: entry.sourceSeqs,
    origin: entry.origin,
    tags: entry.tags,
    evidence: entry.evidence,
    credentialRef: entry.credentialRef,
    supersedes: entry.supersedes,
  }
  switch (entry.type) {
    case 'preference':
      record.topic = entry.topic
      record.value = entry.value
      break
    case 'pitfall':
      record.errorSignature = entry.errorSignature
      record.context = entry.context
      record.solution = entry.solution
      record.appliesTo = entry.appliesTo
      break
    case 'episodic':
      record.summary = entry.summary
      record.request = entry.request
      record.outcome = entry.outcome
      record.sopUsed = entry.sopUsed
      record.promotedTo = entry.promotedTo
      break
    case 'fact':
      record.factKind = entry.factKind
      record.key = entry.key
      record.statement = entry.statement
      record.scope = entry.scope
      break
    case 'sop':
      record.slug = entry.slug
      record.title = entry.title
      record.status = entry.status
      record.version = entry.version
      record.trigger = entry.trigger
      record.steps = entry.steps
      record.tools = entry.tools
      record.successCriteria = entry.successCriteria
      record.promotedTo = entry.promotedTo
      break
  }
  return record
}

/** Serialize one entry as a marker + front matter + optional body block. */
export function serializeMemoryEntry(entry: AnyMemoryEntry): string {
  const yaml = stringifySimpleYaml(entryToRecord(entry)).trimEnd()
  const body = typeof entry.body === 'string' ? entry.body.trim() : ''
  const lines = [MEMORY_ENTRY_MARKER, '---', yaml, '---']
  if (body !== '') lines.push('', body)
  return `${lines.join('\n')}\n`
}

/** Build a typed entry from parsed front matter; returns issues instead of throwing. */
function entryFromRecord(record: Record<string, unknown>, body: string): { entry?: AnyMemoryEntry; issues: MemoryValidationIssue[] } {
  const type = record.type
  if (!isMemoryType(type)) {
    return { issues: [issue('invalid-value', `type must be one of ${MEMORY_TYPES.join(', ')}`, 'type')] }
  }
  const common = {
    id: readString(record, 'id') ?? '',
    privacy: readString(record, 'privacy') ?? 'private',
    createdAt: readString(record, 'createdAt') ?? '',
    ...(readString(record, 'updatedAt') === undefined ? {} : { updatedAt: readString(record, 'updatedAt') }),
    ...(readString(record, 'app') === undefined ? {} : { app: readString(record, 'app') }),
    ...(readString(record, 'scenario') === undefined ? {} : { scenario: readString(record, 'scenario') }),
    ...(readString(record, 'taskType') === undefined ? {} : { taskType: readString(record, 'taskType') }),
    ...(readStringArray(record, 'entities') === undefined ? {} : { entities: readStringArray(record, 'entities') }),
    ...(readString(record, 'sourceSession') === undefined ? {} : { sourceSession: readString(record, 'sourceSession') }),
    ...(readString(record, 'sourceTime') === undefined ? {} : { sourceTime: readString(record, 'sourceTime') }),
    ...(readString(record, 'displayTitle') === undefined ? {} : { displayTitle: readString(record, 'displayTitle') }),
    ...(readString(record, 'sourceLabel') === undefined ? {} : { sourceLabel: readString(record, 'sourceLabel') }),
    ...(readNumberArray(record, 'sourceSeqs') === undefined ? {} : { sourceSeqs: readNumberArray(record, 'sourceSeqs') }),
    ...(isMemoryOrigin(record.origin) ? { origin: record.origin } : {}),
    ...(readStringArray(record, 'tags') === undefined ? {} : { tags: readStringArray(record, 'tags') }),
    ...(readStringArray(record, 'evidence') === undefined ? {} : { evidence: readStringArray(record, 'evidence') }),
    ...(readString(record, 'credentialRef') === undefined ? {} : { credentialRef: readString(record, 'credentialRef') }),
    ...(readString(record, 'supersedes') === undefined ? {} : { supersedes: readString(record, 'supersedes') }),
    ...(body === '' ? {} : { body }),
  }

  let candidate: Record<string, unknown>
  switch (type) {
    case 'preference':
      candidate = { ...common, type, topic: readString(record, 'topic'), value: readString(record, 'value') }
      break
    case 'pitfall':
      candidate = {
        ...common,
        type,
        errorSignature: readString(record, 'errorSignature'),
        context: readString(record, 'context'),
        solution: readString(record, 'solution'),
        ...(readStringArray(record, 'appliesTo') === undefined ? {} : { appliesTo: readStringArray(record, 'appliesTo') }),
      }
      break
    case 'episodic':
      candidate = {
        ...common,
        type,
        summary: readString(record, 'summary'),
        ...(readString(record, 'request') === undefined ? {} : { request: readString(record, 'request') }),
        ...(readString(record, 'outcome') === undefined ? {} : { outcome: readString(record, 'outcome') }),
        ...(readStringArray(record, 'sopUsed') === undefined ? {} : { sopUsed: readStringArray(record, 'sopUsed') }),
        ...(readStringArray(record, 'promotedTo') === undefined ? {} : { promotedTo: readStringArray(record, 'promotedTo') }),
      }
      break
    case 'fact':
      candidate = {
        ...common,
        type,
        factKind: readString(record, 'factKind'),
        key: readString(record, 'key'),
        statement: readString(record, 'statement'),
        ...(readString(record, 'scope') === undefined ? {} : { scope: readString(record, 'scope') }),
      }
      break
    case 'sop':
      candidate = {
        ...common,
        type,
        slug: readString(record, 'slug'),
        title: readString(record, 'title'),
        status: readString(record, 'status'),
        version: readVersion(record),
        trigger: readString(record, 'trigger'),
        steps: readStringArray(record, 'steps'),
        ...(readStringArray(record, 'tools') === undefined ? {} : { tools: readStringArray(record, 'tools') }),
        ...(readStringArray(record, 'successCriteria') === undefined ? {} : { successCriteria: readStringArray(record, 'successCriteria') }),
        ...(readStringArray(record, 'promotedTo') === undefined ? {} : { promotedTo: readStringArray(record, 'promotedTo') }),
      }
      break
  }

  const issues = validateMemoryEntry(candidate)
  if (issues.length > 0) return { issues }
  return { entry: candidate as unknown as AnyMemoryEntry, issues: [] }
}

/**
 * Parse every memory entry in one document.
 *
 * Text outside entry blocks (a file title, maintenance note or fact section
 * heading) is ignored. A malformed block produces an issue and is skipped; the
 * store decides whether that is fatal for a write or just reported by an index
 * read.
 */
export function parseMemoryEntries(source: string): { entries: AnyMemoryEntry[]; issues: MemoryValidationIssue[] } {
  const entries: AnyMemoryEntry[] = []
  const issues: MemoryValidationIssue[] = []
  const blocks = source.split(MEMORY_ENTRY_MARKER).slice(1)
  for (const [index, block] of blocks.entries()) {
    const lines = block.replace(/^\s+/u, '').split(/\r?\n/u)
    if (lines[0]?.trim() !== '---') {
      issues.push(issue('invalid-entry', `entry ${String(index + 1)} does not start with a --- front matter block`))
      continue
    }
    const closing = lines.findIndex((line, lineIndex) => lineIndex > 0 && line.trim() === '---')
    if (closing < 0) {
      issues.push(issue('invalid-entry', `entry ${String(index + 1)} front matter is not closed with ---`))
      continue
    }
    const record = parseSimpleYaml(lines.slice(1, closing).join('\n'))
    const body = lines.slice(closing + 1).join('\n').trim()
    const built = entryFromRecord(record, body)
    issues.push(...built.issues)
    if (built.entry !== undefined) entries.push(built.entry)
  }
  return { entries, issues }
}

/** Render a YAML scalar with the shared quoting rules (exported for tests/tools). */
export const formatMemoryScalar = formatYamlScalar

/** Generate a unique memory id; callers may supply their own stable id instead. */
export const newMemoryId = (): string => `mem-${randomUUID()}`
