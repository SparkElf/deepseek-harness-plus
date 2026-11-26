/**
 * The workflow-plaza publish store.
 *
 * A workflow authored in a conversation is not public when it is written: the record
 * lands as `pending`, an administrator reviews the actual prompt, and only `approved`
 * records enter the plaza. The store lives beside the DSH profile rather than inside the
 * knowledge tree because it is product metadata, not a document: it has no per-user view,
 * no trash, and no DataOps grant semantics.
 *
 * Writes are read-modify-write over one JSON file, serialized per path and committed by
 * atomic rename, so two model calls cannot overwrite each other and a restart never sees
 * a half-written store.
 *
 * @module @sparkelf/dsh-knowledge-base/workflowPublish
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Where a published workflow currently is. */
export type PublishedWorkflowVisibility = 'global' | 'department' | 'private'
export type PublishedWorkflowStatus = 'pending' | 'approved' | 'rejected' | 'unpublished'

/** What the model may publish. */
export interface WorkflowPublishInput {
  readonly title: string
  readonly description: string
  readonly instruction: string
  readonly cronHint?: string
  readonly category?: string
  readonly visibility?: PublishedWorkflowVisibility
  readonly departmentCode?: string
}

/** One authored workflow as stored. */
export interface PublishedWorkflow {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly instruction: string
  readonly cronHint: string
  readonly category: string
  readonly visibility: PublishedWorkflowVisibility
  readonly departmentCode?: string
  readonly authorId: string
  readonly authorName: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly status: PublishedWorkflowStatus
  readonly unpublishedAt?: string
  readonly sourceSessionId?: string
  readonly reviewedAt?: string
  readonly reviewedById?: string
  readonly reviewedByName?: string
  readonly reviewNote?: string
  readonly audit: readonly WorkflowAuditEntry[]
}

/** One durable review/publish event. */
export interface WorkflowAuditEntry {
  readonly at: string
  readonly actorId: string
  readonly actorName: string
  readonly action: 'published' | 'approved' | 'rejected'
  readonly note?: string
}

/** The whole file. */
export interface WorkflowPublishStore {
  readonly version: 1
  readonly workflows: readonly PublishedWorkflow[]
}

/** Structured store failure; the HTTP route and the tool both map these. */
export class WorkflowPublishError extends Error {
  override readonly name = 'WorkflowPublishError'

  constructor(
    readonly code: 'invalid' | 'not-found' | 'already-reviewed' | 'forbidden' | 'io',
    message: string,
  ) {
    super(message)
  }
}

/** The profile-local directory the store lives in. */
export function defaultPublishDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME
    : join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.dsh')
  return join(home, 'workflow-plaza')
}

/** Resolve the configured directory, falling back to the profile-local default. */
export function publishDirOf(configured: string | undefined): string {
  return configured !== undefined && configured.trim() !== '' ? configured : defaultPublishDir()
}

/** The one file in that directory. */
export function publishStorePath(directory: string): string {
  return join(directory, 'published.json')
}

const EMPTY: WorkflowPublishStore = { version: 1, workflows: [] }

const text = (value: unknown, field: string, max: number, required: boolean): string => {
  if (typeof value !== 'string') throw new WorkflowPublishError('invalid', `${field} must be a string`)
  const trimmed = value.trim()
  if (required && trimmed === '') throw new WorkflowPublishError('invalid', `${field} is required`)
  if (trimmed.length > max) throw new WorkflowPublishError('invalid', `${field} is longer than ${String(max)} characters`)
  return trimmed
}

const normalTitle = (title: string): string => title.toLowerCase().replace(/\s+/gu, ' ').trim()

/** Validate and normalize one publish request. */
export function normalizePublishInput(input: WorkflowPublishInput): Required<WorkflowPublishInput> {
  const visibility = input.visibility ?? 'private'
  if (visibility !== 'global' && visibility !== 'department' && visibility !== 'private') {
    throw new WorkflowPublishError('invalid', 'visibility must be global, department or private')
  }
  const departmentCode = text(input.departmentCode ?? '', 'departmentCode', 120, false)
  if (visibility === 'department' && departmentCode === '') {
    throw new WorkflowPublishError('invalid', 'departmentCode is required for department visibility')
  }
  return {
    title: text(input.title, 'title', 120, true),
    description: text(input.description, 'description', 2_000, true),
    instruction: text(input.instruction, 'instruction', 8_000, true),
    cronHint: text(input.cronHint ?? '', 'cronHint', 120, false),
    category: text(input.category ?? '', 'category', 40, false),
    visibility,
    departmentCode: visibility === 'department' ? departmentCode : '',
  }
}

/** Parse a store file, treating absence as empty and quarantining corrupt JSON. */
export async function readWorkflowStore(path: string): Promise<WorkflowPublishStore> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return EMPTY
    throw new WorkflowPublishError('io', `could not read ${path}: ${String(error)}`)
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
    const candidate = parsed as { version?: unknown; workflows?: unknown }
    if (candidate.version !== 1 || !Array.isArray(candidate.workflows)) throw new Error('wrong shape')
    return { version: 1, workflows: candidate.workflows as readonly PublishedWorkflow[] }
  } catch (error) {
    // Keep the bytes for inspection instead of silently discarding a user's work.
    await rename(path, `${path}.corrupt-${String(Date.now())}`).catch(() => undefined)
    if (error instanceof WorkflowPublishError) throw error
    return EMPTY
  }
}

const writeQueues = new Map<string, Promise<unknown>>()

/** Serialize all mutations of one store path. */
function serialize<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(path) ?? Promise.resolve()
  const next = previous.then(operation, operation)
  writeQueues.set(path, next.then(() => undefined, () => undefined))
  return next
}

/** Commit the store atomically (write beside it, then rename). */
export async function writeWorkflowStore(path: string, store: WorkflowPublishStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    throw new WorkflowPublishError('io', `could not write ${path}: ${String(error)}`)
  }
}

/** The caller who authors/reviews a record. */
export interface WorkflowActor {
  readonly id: string
  readonly name: string
}

/** Result of a publish attempt; `duplicate` means the pending record already existed. */
export interface PublishResult {
  readonly record: PublishedWorkflow
  readonly duplicate: boolean
}

/**
 * Publish one workflow as pending.
 *
 * Deduplication is deliberately scoped to `(normalized title, author, pending)`: a
 * second model call in the same conversation must not create a second review card, while
 * a rejected workflow may be resubmitted after edits.
 */
export async function publishWorkflow(
  path: string,
  input: WorkflowPublishInput,
  actor: WorkflowActor,
  sourceSessionId?: string,
  now: () => Date = () => new Date(),
): Promise<PublishResult> {
  const normalized = normalizePublishInput(input)
  return serialize(path, async () => {
    const store = await readWorkflowStore(path)
    const titleKey = normalTitle(normalized.title)
    const duplicate = store.workflows.find(item => item.status === 'pending'
      && item.authorId === actor.id
      && normalTitle(item.title) === titleKey)
    if (duplicate !== undefined) return { record: duplicate, duplicate: true }

    const at = now().toISOString()
    const record: PublishedWorkflow = {
      id: `wf-${randomUUID()}`,
      ...normalized,
      authorId: actor.id,
      authorName: actor.name,
      createdAt: at,
      updatedAt: at,
      status: 'pending',
      ...(sourceSessionId === undefined || sourceSessionId === '' ? {} : { sourceSessionId }),
      audit: [{ at, actorId: actor.id, actorName: actor.name, action: 'published' }],
    }
    await writeWorkflowStore(path, { version: 1, workflows: [...store.workflows, record] })
    return { record, duplicate: false }
  })
}

/** Update one local record's mutable copy, stamping updatedAt and an audit entry. */
export async function updatePublishedWorkflow(
  path: string,
  id: string,
  patch: Partial<Pick<PublishedWorkflow, 'title' | 'description' | 'instruction' | 'cronHint' | 'category' | 'visibility' | 'departmentCode'>>,
  actor: WorkflowActor,
  now: () => Date = () => new Date(),
): Promise<PublishedWorkflow> {
  return serialize(path, async () => {
    const store = await readWorkflowStore(path)
    const record = store.workflows.find(item => item.id === id)
    if (record === undefined) throw new WorkflowPublishError('not-found', `no workflow with id ${id}`)
    if (record.authorId !== actor.id) throw new WorkflowPublishError('forbidden', `workflow ${id} belongs to another author`)
    const at = now().toISOString()
    const next: PublishedWorkflow = {
      ...record,
      ...patch,
      updatedAt: at,
      audit: [...record.audit, { at, actorId: actor.id, actorName: actor.name, action: 'published' }],
    }
    await writeWorkflowStore(path, { version: 1, workflows: store.workflows.map(item => item.id === id ? next : item) })
    return next
  })
}

/** Mark one local workflow unpublished (retained for the owner's history). */
export async function unpublishPublishedWorkflow(
  path: string,
  id: string,
  actor: WorkflowActor,
  now: () => Date = () => new Date(),
): Promise<PublishedWorkflow> {
  return serialize(path, async () => {
    const store = await readWorkflowStore(path)
    const record = store.workflows.find(item => item.id === id)
    if (record === undefined) throw new WorkflowPublishError('not-found', `no workflow with id ${id}`)
    if (record.authorId !== actor.id) throw new WorkflowPublishError('forbidden', `workflow ${id} belongs to another author`)
    const at = now().toISOString()
    const next: PublishedWorkflow = {
      ...record,
      status: 'unpublished',
      unpublishedAt: at,
      updatedAt: at,
      audit: [...record.audit, { at, actorId: actor.id, actorName: actor.name, action: 'rejected', note: 'unpublished' }],
    }
    await writeWorkflowStore(path, { version: 1, workflows: store.workflows.map(item => item.id === id ? next : item) })
    return next
  })
}

/** Every record authored by one person, newest update first (the mine tab source). */
export async function listWorkflowsForAuthor(
  path: string,
  authorId: string,
): Promise<readonly PublishedWorkflow[]> {
  const store = await readWorkflowStore(path)
  return store.workflows
    .filter(item => item.authorId === authorId)
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Put one rejected/unpublished workflow back into the pending review queue. */
export async function resubmitPublishedWorkflow(
  path: string,
  id: string,
  actor: WorkflowActor,
  now: () => Date = () => new Date(),
): Promise<PublishedWorkflow> {
  return serialize(path, async () => {
    const store = await readWorkflowStore(path)
    const record = store.workflows.find(item => item.id === id)
    if (record === undefined) throw new WorkflowPublishError('not-found', `no workflow with id ${id}`)
    if (record.authorId !== actor.id) throw new WorkflowPublishError('forbidden', `workflow ${id} belongs to another author`)
    if (record.status !== 'rejected' && record.status !== 'unpublished') {
      throw new WorkflowPublishError('invalid', `workflow ${id} is ${record.status}; only rejected/unpublished can be resubmitted`)
    }
    const at = now().toISOString()
    const next: PublishedWorkflow = {
      ...record,
      status: 'pending',
      updatedAt: at,
      reviewedAt: undefined,
      reviewedById: undefined,
      reviewedByName: undefined,
      reviewNote: undefined,
      unpublishedAt: undefined,
      audit: [...record.audit, { at, actorId: actor.id, actorName: actor.name, action: 'published' }],
    }
    await writeWorkflowStore(path, { version: 1, workflows: store.workflows.map(item => item.id === id ? next : item) })
    return next
  })
}

/** Approved workflows, newest first. */
export async function listApprovedWorkflows(path: string): Promise<readonly PublishedWorkflow[]> {
  const store = await readWorkflowStore(path)
  return store.workflows
    .filter(item => item.status === 'approved')
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Pending workflows for the review tab, oldest first so the queue reads in arrival order. */
export async function listPendingWorkflows(path: string): Promise<readonly PublishedWorkflow[]> {
  const store = await readWorkflowStore(path)
  return store.workflows
    .filter(item => item.status === 'pending')
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Approve or reject one pending workflow. Rejected records stay in the store. */
export async function reviewWorkflow(
  path: string,
  id: string,
  decision: 'approve' | 'reject',
  actor: WorkflowActor,
  note?: string,
  now: () => Date = () => new Date(),
): Promise<PublishedWorkflow> {
  const reviewNote = typeof note === 'string' ? note.trim().slice(0, 2_000) : ''
  if (decision !== 'approve' && decision !== 'reject') {
    throw new WorkflowPublishError('invalid', 'decision must be approve or reject')
  }
  return serialize(path, async () => {
    const store = await readWorkflowStore(path)
    const record = store.workflows.find(item => item.id === id)
    if (record === undefined) throw new WorkflowPublishError('not-found', `no workflow with id ${id}`)
    if (record.status !== 'pending') {
      throw new WorkflowPublishError('already-reviewed', `workflow ${id} is already ${record.status}`)
    }
    const at = now().toISOString()
    const status: PublishedWorkflowStatus = decision === 'approve' ? 'approved' : 'rejected'
    const reviewed: PublishedWorkflow = {
      ...record,
      status,
      reviewedAt: at,
      reviewedById: actor.id,
      reviewedByName: actor.name,
      ...(reviewNote === '' ? {} : { reviewNote }),
      audit: [...record.audit, {
        at,
        actorId: actor.id,
        actorName: actor.name,
        action: status,
        ...(reviewNote === '' ? {} : { note: reviewNote }),
      }],
    }
    await writeWorkflowStore(path, {
      version: 1,
      workflows: store.workflows.map(item => item.id === id ? reviewed : item),
    })
    return reviewed
  })
}
