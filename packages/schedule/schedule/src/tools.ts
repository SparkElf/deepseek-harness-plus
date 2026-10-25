/**
 * Agent-scoped Schedule management tools over the durable session fold.
 * @module @deepseek-ai/dsh-schedule
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import {
  canListAll,
  callerRole,
  forbidden,
  listAllScope,
  ownerForSession,
  requestWriteApproval,
} from './access.ts'
import {
  allocateScheduleId,
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createEveryScheduleRecord,
  foldScheduleEvents,
  MIN_EVERY_INTERVAL_SECONDS,
  renderEveryReminderBatchFraming,
  renderReminderFraming,
  resolveEveryOccurrence,
  ScheduleId,
  ScheduleInputError,
  ScheduleLogError,
  scheduleView,
} from './domain.ts'
import { latestScheduleRun, scheduleRunLogs } from './history.ts'
import { flushSchedulePersistence } from './persistence.ts'
import { runScheduleTransaction } from './transaction.ts'
import type {
  AtInput,
  PersistenceUncertainError,
  ScheduleAccessConfig,
  ScheduleCreateValue,
  ScheduleDeleteValue,
  ScheduleGetValue,
  ScheduleId as ScheduleIdType,
  InternalScheduleError,
  ScheduleListAllRow,
  ScheduleListAllValue,
  ScheduleListValue,
  ScheduleLogsValue,
  ScheduleManageValue,
  ScheduleManagementError,
  SchedulePersistenceOperation,
  ScheduleRecord,
  ScheduleRunNowValue,
  ScheduleToolError,
} from './types.ts'

const SHARED_VIEW_PROPERTIES = {
  id: { type: 'string', required: true },
  prompt: { type: 'string', required: true },
  scheduledAt: { type: 'string', required: true },
  state: { type: 'string', required: true, enum: ['scheduled', 'overdue'] },
  enabled: { type: 'boolean', required: true },
  deliveryMode: { type: 'string', required: true, const: 'session-local' },
} as const

const AFTER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'after' },
    afterSeconds: { type: 'integer', required: true },
  },
} as const

const AT_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'at' },
  },
} as const

const EVERY_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'every' },
    everySeconds: { type: 'integer', required: true },
  },
} as const

const VIEW_SCHEMA = { oneOf: [AFTER_VIEW_SCHEMA, AT_VIEW_SCHEMA, EVERY_VIEW_SCHEMA] } as const

/** Build one exact two-field error schema while preserving its literal code. */
function basicErrorSchema<const C extends string>(code: C) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: { type: 'string', required: true, const: code },
      message: { type: 'string', required: true },
    },
  } as const
}

const BASIC_ERROR_SCHEMAS = [
  basicErrorSchema('invalid_prompt'),
  basicErrorSchema('invalid_selector'),
  basicErrorSchema('invalid_rule'),
  basicErrorSchema('invalid_time_zone'),
  basicErrorSchema('not_future'),
  basicErrorSchema('time_out_of_range'),
  basicErrorSchema('frequency_too_high'),
  basicErrorSchema('corrupt_schedule_log'),
  basicErrorSchema('internal_error'),
] as const

const MANAGEMENT_BASIC_ERROR_SCHEMAS = [
  ...BASIC_ERROR_SCHEMAS,
  basicErrorSchema('forbidden'),
  basicErrorSchema('approval_rejected'),
  basicErrorSchema('approval_unavailable'),
  basicErrorSchema('invalid_update'),
  basicErrorSchema('invalid_limit'),
] as const

const PERSISTENCE_ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true, const: 'persistence_uncertain' },
    message: { type: 'string', required: true },
    operation: {
      type: 'string',
      required: true,
      enum: ['create', 'list', 'delete', 'get', 'update', 'pause', 'resume', 'run', 'logs', 'list_all'],
    },
    id: { type: 'string' },
  },
} as const

const NOT_FOUND_ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true, const: 'schedule_not_found' },
    message: { type: 'string', required: true },
    id: { type: 'string', required: true },
  },
} as const

const ALREADY_PAUSED_ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true, const: 'already_paused' },
    message: { type: 'string', required: true },
    id: { type: 'string', required: true },
  },
} as const

const NOT_PAUSED_ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true, const: 'not_paused' },
    message: { type: 'string', required: true },
    id: { type: 'string', required: true },
  },
} as const

const ERROR_SCHEMAS = [
  ...BASIC_ERROR_SCHEMAS,
  PERSISTENCE_ERROR_SCHEMA,
] as const

const MANAGEMENT_ERROR_SCHEMAS = [
  ...MANAGEMENT_BASIC_ERROR_SCHEMAS,
  PERSISTENCE_ERROR_SCHEMA,
  NOT_FOUND_ERROR_SCHEMA,
  ALREADY_PAUSED_ERROR_SCHEMA,
  NOT_PAUSED_ERROR_SCHEMA,
] as const

const RUN_LOG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string', required: true },
    scheduleId: { type: 'string', required: true },
    at: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['dispatched', 'triggered', 'failed'] },
    trigger: { type: 'string', required: true, enum: ['due', 'manual'] },
    error: { type: 'string' },
    durationMs: { type: 'integer' },
  },
} as const

const CREATE_OUTPUT_SCHEMA = { oneOf: [VIEW_SCHEMA, ...ERROR_SCHEMAS] } as const
const LIST_OUTPUT_SCHEMA = {
  oneOf: [
    { type: 'array', items: VIEW_SCHEMA },
    ...ERROR_SCHEMAS,
  ],
} as const
const DELETE_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        deleted: { type: 'boolean', required: true, const: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        deleted: { type: 'boolean', required: true, const: false },
        code: { type: 'string', required: true, const: 'schedule_not_found' },
      },
    },
    ...ERROR_SCHEMAS,
  ],
} as const

const AFTER_GET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...AFTER_VIEW_SCHEMA.properties,
    lastRun: RUN_LOG_SCHEMA,
  },
} as const

const AT_GET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...AT_VIEW_SCHEMA.properties,
    lastRun: RUN_LOG_SCHEMA,
  },
} as const

const EVERY_GET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...EVERY_VIEW_SCHEMA.properties,
    lastRun: RUN_LOG_SCHEMA,
  },
} as const

const GET_OUTPUT_SCHEMA = {
  oneOf: [AFTER_GET_SCHEMA, AT_GET_SCHEMA, EVERY_GET_SCHEMA, ...MANAGEMENT_ERROR_SCHEMAS],
} as const

const MANAGE_OUTPUT_SCHEMA = {
  oneOf: [VIEW_SCHEMA, ...MANAGEMENT_ERROR_SCHEMAS],
} as const

const RUN_NOW_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        runId: { type: 'string', required: true },
        id: { type: 'string', required: true },
        status: { type: 'string', required: true, const: 'triggered' },
        at: { type: 'string', required: true },
      },
    },
    ...MANAGEMENT_ERROR_SCHEMAS,
  ],
} as const

const LOGS_OUTPUT_SCHEMA = {
  oneOf: [
    { type: 'array', items: RUN_LOG_SCHEMA },
    ...MANAGEMENT_ERROR_SCHEMAS,
  ],
} as const

const LIST_ALL_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    owner: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        userId: { type: 'string', required: true },
        userName: { type: 'string' },
        departmentCode: { type: 'string' },
        departmentName: { type: 'string' },
      },
    },
    schedule: VIEW_SCHEMA,
  },
} as const

const LIST_ALL_OUTPUT_SCHEMA = {
  oneOf: [
    { type: 'array', items: LIST_ALL_ROW_SCHEMA },
    ...MANAGEMENT_ERROR_SCHEMAS,
  ],
} as const

const CREATE_DESCRIPTION =
  'Create one reminder in the current session. Supply a non-empty prompt and exactly one selector: '
  + 'a positive safe-integer after_seconds delay, at as a strict offset date-time or local '
  + `date/time object, or safe-integer every_seconds of at least ${MIN_EVERY_INTERVAL_SECONDS}. `
  + 'Fixed-rate reminders stay creation-aligned, skip missed occurrences, and batch one latest '
  + 'occurrence per overdue rule. '
  + 'Delivery is session-local: the reminder runs on time only while this session '
  + 'is live and otherwise becomes overdue until the session is resumed.'

const LIST_DESCRIPTION =
  'List every active reminder in the current session in creation order, including its exact id, '
  + 'UTC target, scheduled or overdue state, and session-local delivery mode.'

const DELETE_DESCRIPTION =
  'Delete one active reminder in the current session by the exact id returned by schedule_create '
  + 'or schedule_list. Unknown or already-finished ids return deleted false.'

const GET_DESCRIPTION =
  'Read one active reminder in the current session by exact id. Returns its rule, next target, '
  + 'scheduled/overdue state, enabled flag, and the latest durable run receipt when it has run.'

const UPDATE_DESCRIPTION =
  'Update one active reminder in the current session. Supply the exact id and at least one of prompt, '
  + 'one new rule selector (after_seconds, at, or every_seconds), or enabled. Rule changes recompute '
  + 'the target from now; enabled false pauses and true resumes. This write requires human approval '
  + 'and is audited.'

const PAUSE_DESCRIPTION =
  'Pause one active reminder without deleting it or its history. A paused reminder never fires until '
  + 'resumed. This write requires human approval and is audited.'

const RESUME_DESCRIPTION =
  'Resume one paused reminder, keeping its original rule and history. This write requires human '
  + 'approval and is audited.'

const RUN_NOW_DESCRIPTION =
  'Trigger one active reminder immediately in the current session and return its run id. The reminder '
  + 'stays active and keeps its rule. This write requires human approval and is audited.'

const LOGS_DESCRIPTION =
  'List recent run receipts for one reminder or the whole current session, newest first. Administrators '
  + 'may name another session_id within their permitted scope. Entries expose time, status, trigger, '
  + 'error, and duration, never the reminder prompt.'

const LIST_ALL_DESCRIPTION =
  'List active reminders across Sessions. Requires an administrator role. Super administrators and '
  + 'administrators may filter by department and user; a department administrator is restricted to '
  + 'their own department. Filters are validated on the server.'

/** Deterministic model content for every canonical Schedule value. */
function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  // The ToolRuntime has already validated the value against the lossless-JSON output schema.
  const text = JSON.stringify(value)
  return [{ type: 'text', text }]
}

/** Pure generic pending card. */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** Stable error for failures not safe to expose. */
function internalError(): InternalScheduleError {
  return { code: 'internal_error', message: 'The schedule operation failed.' }
}

/** Placeholder the registry replaces with its canonical ABORTED result after body quiescence. */
function cancellationPlaceholder(signal: AbortSignal): InternalScheduleError | undefined {
  return signal.aborted ? internalError() : undefined
}

/** Serialize one operation, stopping a body whose caller cancelled before its FIFO turn. */
function runCancellableScheduleTransaction<T>(
  agent: Agent,
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T | InternalScheduleError> {
  return runScheduleTransaction(agent, async () => {
    const cancelled = cancellationPlaceholder(signal)
    return cancelled ?? task()
  })
}

/** Stable durable-log failure. */
function corruptLogError(): ScheduleToolError {
  return { code: 'corrupt_schedule_log', message: 'The session schedule log is corrupt.' }
}

/** Stable persistence uncertainty with the known operation identity. */
function persistenceError(
  operation: SchedulePersistenceOperation,
  id?: ScheduleIdType,
): PersistenceUncertainError {
  return {
    code: 'persistence_uncertain',
    message: 'Schedule persistence is uncertain; retry with schedule_list before relying on this result.',
    operation,
    ...id === undefined ? {} : { id },
  }
}

/** Translate one contained input failure to the closed tool union. */
function inputError(error: ScheduleInputError): ScheduleToolError {
  return { code: error.code, message: error.message }
}

/** Fold only after a successful preflight, mapping corruption to a stable value. */
function foldForTool(agent: Agent): ReturnType<typeof foldScheduleEvents> | ScheduleToolError {
  try {
    return foldScheduleEvents(agent.session.ownEvents())
  } catch (error: unknown) {
    return error instanceof ScheduleLogError ? corruptLogError() : internalError()
  }
}

/** Whether a fold attempt produced an error rather than replay state. */
function isToolError(
  value: ReturnType<typeof foldScheduleEvents> | ScheduleToolError,
): value is ScheduleToolError {
  return 'code' in value
}

/** Require one persistence checkpoint without leaking the backend failure. */
async function preflight(
  rootCtx: Context,
  agent: Agent,
  operation: SchedulePersistenceOperation,
  id?: ScheduleIdType,
): Promise<PersistenceUncertainError | undefined> {
  try {
    await flushSchedulePersistence(rootCtx, agent.session)
    return undefined
  } catch {
    return persistenceError(operation, id)
  }
}

/** Stable actor label for audit entries. */
function actorFor(config: ScheduleAccessConfig | undefined, agent: Agent): string {
  return ownerForSession(config, agent.session.id).userId
}

/** Append one audit receipt; containment keeps the primary result authoritative. */
function appendAudit(
  agent: Agent,
  actor: string,
  action: 'update' | 'pause' | 'resume' | 'run_now',
  outcome: 'allowed' | 'rejected' | 'failed',
  scheduleId?: ScheduleIdType,
  detail?: string,
): void {
  try {
    agent.session.append('schedule/change', {
      version: 1,
      operation: 'audit',
      audit: {
        auditId: randomUUID(),
        actor,
        action,
        outcome,
        at: new Date().toISOString(),
        ...scheduleId === undefined ? {} : { scheduleId },
        ...detail === undefined ? {} : { detail },
      },
    })
  } catch {
    // The primary operation already committed or was rejected; a closed Session cannot accept the receipt.
  }
}

/** Build one view honoring the current pause set. */
function viewOf(
  record: ScheduleRecord,
  folded: ReturnType<typeof foldScheduleEvents>,
  now: number,
): ReturnType<typeof scheduleView> {
  return scheduleView(record, now, !folded.paused.includes(record.id))
}

/** Resolve one id against the current fold. */
function recordById(
  folded: ReturnType<typeof foldScheduleEvents>,
  id: ScheduleIdType,
): ScheduleRecord | undefined {
  return folded.active.find(record => record.id === id)
}

/** Normalize one optional prompt and reject an empty replacement. */
function normalizedPrompt(prompt: string | undefined): string | ScheduleToolError | undefined {
  if (prompt === undefined) return undefined
  const trimmed = prompt.trim()
  if (trimmed.length === 0) {
    return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
  }
  return trimmed
}

/** Validate the v1 selector constraints that the open parameter root cannot express. */
function validateCreateArgs(args: {
  prompt: string
  after_seconds?: number
  at?: AtInput
  every_seconds?: number
}): ScheduleToolError | undefined {
  const keys = Object.keys(args as unknown as Record<string, unknown>)
  if (keys.some(key => key !== 'prompt'
    && key !== 'after_seconds'
    && key !== 'at'
    && key !== 'every_seconds')
    || Number(args.after_seconds !== undefined)
    + Number(args.at !== undefined)
    + Number(args.every_seconds !== undefined) !== 1) {
    return {
      code: 'invalid_selector',
      message: 'schedule_create accepts exactly one of after_seconds, at, or every_seconds.',
    }
  }
  if (args.prompt.trim().length === 0) {
    return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
  }
  if (args.after_seconds !== undefined
    && (!Number.isSafeInteger(args.after_seconds) || args.after_seconds <= 0)) {
    return { code: 'invalid_rule', message: 'after_seconds must be a positive safe integer.' }
  }
  if (args.every_seconds !== undefined && !Number.isSafeInteger(args.every_seconds)) {
    return { code: 'invalid_rule', message: 'every_seconds must be a safe integer.' }
  }
  if (args.every_seconds !== undefined && args.every_seconds < MIN_EVERY_INTERVAL_SECONDS) {
    return {
      code: 'frequency_too_high',
      message: `every_seconds must be at least ${MIN_EVERY_INTERVAL_SECONDS}.`,
    }
  }
  return undefined
}

/**
 * Register the Schedule management tools in one exact agent scope.
 * @param rootCtx - Global service context owning sessions and durability.
 * @param toolCtx - Exact agent-scoped context receiving the definitions.
 * @param agent - Exact live owner whose session the tools mutate.
 * @param onDurableChange - Called after every successful preflight and again after a create or actual delete barrier succeeds.
 * @param access - Optional deployment role and owner policy for management authorization.
 * @returns Idempotent aggregate disposer for every registration.
 */
export function registerScheduleTools(
  rootCtx: Context,
  toolCtx: Context,
  agent: Agent,
  onDurableChange: () => void,
  access: ScheduleAccessConfig = {},
): () => void {
  const disposers: Array<() => void> = []

  /** A projection observer cannot reverse a completed durability barrier. */
  const notifyDurableChange = (): void => {
    try {
      onDurableChange()
    } catch (error: unknown) {
      rootCtx.logger.warn(`schedule: durable-change observer failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  try {
    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_create',
      description: CREATE_DESCRIPTION,
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: 'Reminder content to present when the target becomes due.',
        },
        after_seconds: {
          type: 'number',
          description: 'Positive safe-integer delay in seconds.',
        },
        every_seconds: {
          type: 'number',
          description: `Fixed-rate safe-integer interval in seconds, at least ${MIN_EVERY_INTERVAL_SECONDS}.`,
        },
        at: {
          description: 'Absolute target as strict offset RFC 3339 or local date/time with an explicit IANA zone.',
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                date: { type: 'string', required: true },
                time: { type: 'string', required: true },
                time_zone: { type: 'string', required: true },
              },
            },
          ],
        },
      },
      output: { schema: CREATE_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec): Promise<ScheduleCreateValue> {
        if (exec.agent !== agent) return internalError()
        const invalid = validateCreateArgs(args)
        if (invalid !== undefined) return invalid
        return runCancellableScheduleTransaction(agent, exec.signal, async () => {
          const uncertain = await preflight(rootCtx, agent, 'create')
          if (uncertain !== undefined) return uncertain
          notifyDurableChange()
          const folded = foldForTool(agent)
          if (isToolError(folded)) return folded
          const id = allocateScheduleId(folded)
          let record: ScheduleRecord
          try {
            if (args.at !== undefined) {
              record = createAtScheduleRecord(id, args.prompt, args.at, Date.now())
            } else if (args.after_seconds !== undefined) {
              record = createAfterScheduleRecord(id, args.prompt, args.after_seconds, Date.now())
            } else {
              record = createEveryScheduleRecord(
                id,
                args.prompt,
                args.every_seconds as number,
                Date.now(),
              )
            }
          } catch (error: unknown) {
            return error instanceof ScheduleInputError ? inputError(error) : internalError()
          }
          const cancelledBeforeAppend = cancellationPlaceholder(exec.signal)
          if (cancelledBeforeAppend !== undefined) return cancelledBeforeAppend
          try {
            agent.session.append('schedule/change', {
              version: 1,
              operation: 'create',
              schedule: record,
            })
          } catch {
            return internalError()
          }
          const barrier = await preflight(rootCtx, agent, 'create', id)
          if (barrier !== undefined) return barrier
          notifyDurableChange()
          return scheduleView(record, Date.now())
        })
      },
      presentCall: args => present('Create reminder', 'other', args.prompt),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_list',
      description: LIST_DESCRIPTION,
      parameters: {},
      output: { schema: LIST_OUTPUT_SCHEMA, render: renderValue },
      async execute(_args, exec): Promise<ScheduleListValue> {
        if (exec.agent !== agent) return internalError()
        return runCancellableScheduleTransaction(agent, exec.signal, async () => {
          const uncertain = await preflight(rootCtx, agent, 'list')
          if (uncertain !== undefined) return uncertain
          notifyDurableChange()
          const folded = foldForTool(agent)
          if (isToolError(folded)) return folded
          const now = Date.now()
          return folded.active.map(record => viewOf(record, folded, now))
        })
      },
      presentCall: () => present('List reminders', 'read'),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_delete',
      description: DELETE_DESCRIPTION,
      parameters: {
        id: { type: 'string', required: true, description: 'Exact session-local schedule id.' },
      },
      output: { schema: DELETE_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec): Promise<ScheduleDeleteValue> {
        if (args.id.length === 0 || args.id.trim() !== args.id) {
          return { code: 'invalid_rule', message: 'schedule_delete id must be non-empty without surrounding whitespace.' }
        }
        const id = ScheduleId(args.id)
        if (exec.agent !== agent) return internalError()
        return runCancellableScheduleTransaction(agent, exec.signal, async () => {
          const uncertain = await preflight(rootCtx, agent, 'delete', id)
          if (uncertain !== undefined) return uncertain
          notifyDurableChange()
          const folded = foldForTool(agent)
          if (isToolError(folded)) return folded
          if (!folded.active.some(record => record.id === id)) {
            return { id, deleted: false, code: 'schedule_not_found' }
          }
          const cancelledBeforeAppend = cancellationPlaceholder(exec.signal)
          if (cancelledBeforeAppend !== undefined) return cancelledBeforeAppend
          try {
            agent.session.append('schedule/change', { version: 1, operation: 'delete', id })
          } catch {
            return internalError()
          }
          const barrier = await preflight(rootCtx, agent, 'delete', id)
          if (barrier !== undefined) return barrier
          notifyDurableChange()
          return { id, deleted: true }
        })
      },
      presentCall: args => present('Delete reminder', 'other', args.id),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_get',
      description: GET_DESCRIPTION,
      parameters: {
        id: { type: 'string', required: true, description: 'Exact session-local schedule id.' },
      },
      output: { schema: GET_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec): Promise<ScheduleGetValue> {
        if (args.id.length === 0 || args.id.trim() !== args.id) {
          return { code: 'invalid_rule', message: 'schedule_get id must be non-empty without surrounding whitespace.' }
        }
        const id = ScheduleId(args.id)
        if (exec.agent !== agent) return internalError()
        return runCancellableScheduleTransaction(agent, exec.signal, async () => {
          const uncertain = await preflight(rootCtx, agent, 'get', id)
          if (uncertain !== undefined) return uncertain
          notifyDurableChange()
          const folded = foldForTool(agent)
          if (isToolError(folded)) return folded
          const record = recordById(folded, id)
          if (record === undefined) {
            return { code: 'schedule_not_found', message: 'No active reminder has this id.', id }
          }
          const lastRun = latestScheduleRun(agent.session.ownEvents(), 0, id)
          const view = viewOf(record, folded, Date.now())
          return { ...view, ...lastRun === undefined ? {} : { lastRun } }
        })
      },
      presentCall: args => present('Get reminder', 'read', args.id),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_update',
      description: UPDATE_DESCRIPTION,
      parameters: {
        id: { type: 'string', required: true, description: 'Exact session-local schedule id.' },
        prompt: { type: 'string', description: 'Replacement reminder content.' },
        after_seconds: { type: 'number', description: 'Replacement positive safe-integer delay in seconds.' },
        every_seconds: { type: 'number', description: `Replacement fixed-rate interval of at least ${MIN_EVERY_INTERVAL_SECONDS} seconds.` },
        at: {
          description: 'Replacement absolute target as strict offset RFC 3339 or local date/time with an explicit IANA zone.',
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                date: { type: 'string', required: true },
                time: { type: 'string', required: true },
                time_zone: { type: 'string', required: true },
              },
            },
          ],
        },
        enabled: { type: 'boolean', description: 'False pauses the reminder; true resumes it.' },
      },
      output: { schema: MANAGE_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec): Promise<ScheduleManageValue> {
        if (args.id.length === 0 || args.id.trim() !== args.id) {
          return { code: 'invalid_rule', message: 'schedule_update id must be non-empty without surrounding whitespace.' }
        }
        const id = ScheduleId(args.id)
        const selectorCount = [args.after_seconds, args.at, args.every_seconds].filter(value => value !== undefined).length
        if (selectorCount > 1) {
          return { code: 'invalid_update', message: 'schedule_update accepts at most one rule selector.' }
        }
        if (selectorCount === 0 && args.prompt === undefined && args.enabled === undefined) {
          return { code: 'invalid_update', message: 'schedule_update requires prompt, a rule selector, or enabled.' }
        }
        if (exec.agent !== agent) return internalError()
        const actor = actorFor(access, agent)
        const approval = await requestWriteApproval(
          rootCtx,
          agent,
          'schedule_update',
          String(exec.callId),
          `Update Schedule reminder ${id}.`,
          exec.signal,
        )
        if (!approval.allowed) {
          appendAudit(agent, actor, 'update', 'rejected', id, approval.error.code)
          return approval.error
        }
        return runCancellableScheduleTransaction(agent, exec.signal, async () => {
          const uncertain = await preflight(rootCtx, agent, 'update', id)
          if (uncertain !== undefined) return uncertain
          notifyDurableChange()
          const folded = foldForTool(agent)
          if (isToolError(folded)) return folded
          const record = recordById(folded, id)
          if (record === undefined) {
            const notFound: ScheduleManagementError = { code: 'schedule_not_found', message: 'No active reminder has this id.', id }
            appendAudit(agent, actor, 'update', 'failed', id, notFound.code)
            return notFound
          }
          const prompt = normalizedPrompt(args.prompt)
          if (prompt !== undefined && typeof prompt !== 'string') {
            appendAudit(agent, actor, 'update', 'failed', id, prompt.code)
            return prompt
          }
          let next: ScheduleRecord
          try {
            const now = Date.now()
            if (args.at !== undefined) {
              next = createAtScheduleRecord(id, prompt ?? record.prompt, args.at, now)
            } else if (args.after_seconds !== undefined) {
              next = createAfterScheduleRecord(id, prompt ?? record.prompt, args.after_seconds, now)
            } else if (args.every_seconds !== undefined) {
              next = createEveryScheduleRecord(id, prompt ?? record.prompt, args.every_seconds, now)
            } else {
              next = Object.freeze({ ...record, prompt: prompt ?? record.prompt })
            }
          } catch (error: unknown) {
            const failure = error instanceof ScheduleInputError ? inputError(error) : internalError()
            appendAudit(agent, actor, 'update', 'failed', id, failure.code)
            return failure
          }
          const wasPaused = folded.paused.includes(id)
          const pause = args.enabled === false && !wasPaused
          const resume = args.enabled === true && wasPaused
          try {
            if (selectorCount > 0 || prompt !== undefined) {
              agent.session.append('schedule/change', { version: 1, operation: 'update', schedule: next })
            }
            if (pause) {
              agent.session.append('schedule/change', { version: 1, operation: 'pause', id })
            } else if (resume) {
              agent.session.append('schedule/change', { version: 1, operation: 'resume', id })
            }
          } catch {
            appendAudit(agent, actor, 'update', 'failed', id, 'internal_error')
            return internalError()
          }
          const barrier = await preflight(rootCtx, agent, 'update', id)
          if (barrier !== undefined) {
            appendAudit(agent, actor, 'update', 'failed', id, barrier.code)
            return barrier
          }
          notifyDurableChange()
          appendAudit(agent, actor, 'update', 'allowed', id)
          return scheduleView(next, Date.now(), !(pause || (wasPaused && !resume)))
        })
      },
      presentCall: args => present('Update reminder', 'other', args.id),
    })))

    for (const operation of ['pause', 'resume'] as const) {
      disposers.push(toolCtx.tools.register(defineTool({
        name: `schedule_${operation}`,
        description: operation === 'pause' ? PAUSE_DESCRIPTION : RESUME_DESCRIPTION,
        parameters: {
          id: { type: 'string', required: true, description: 'Exact session-local schedule id.' },
        },
        output: { schema: MANAGE_OUTPUT_SCHEMA, render: renderValue },
        async execute(args, exec): Promise<ScheduleManageValue> {
          if (args.id.length === 0 || args.id.trim() !== args.id) {
            return { code: 'invalid_rule', message: `schedule_${operation} id must be non-empty without surrounding whitespace.` }
          }
          const id = ScheduleId(args.id)
          if (exec.agent !== agent) return internalError()
          const actor = actorFor(access, agent)
          const approval = await requestWriteApproval(
            rootCtx,
            agent,
            `schedule_${operation}`,
            String(exec.callId),
            `${operation === 'pause' ? 'Pause' : 'Resume'} Schedule reminder ${id}.`,
            exec.signal,
          )
          if (!approval.allowed) {
            appendAudit(agent, actor, operation, 'rejected', id, approval.error.code)
            return approval.error
          }
          return runCancellableScheduleTransaction(agent, exec.signal, async () => {
            const uncertain = await preflight(rootCtx, agent, operation, id)
            if (uncertain !== undefined) return uncertain
            notifyDurableChange()
            const folded = foldForTool(agent)
            if (isToolError(folded)) return folded
            const record = recordById(folded, id)
            if (record === undefined) {
              const notFound: ScheduleManagementError = { code: 'schedule_not_found', message: 'No active reminder has this id.', id }
              appendAudit(agent, actor, operation, 'failed', id, notFound.code)
              return notFound
            }
            const isPaused = folded.paused.includes(id)
            if (operation === 'pause' && isPaused) {
              return { code: 'already_paused', message: 'The reminder is already paused.', id }
            }
            if (operation === 'resume' && !isPaused) {
              return { code: 'not_paused', message: 'The reminder is not paused.', id }
            }
            try {
              agent.session.append('schedule/change', { version: 1, operation, id })
            } catch {
              appendAudit(agent, actor, operation, 'failed', id, 'internal_error')
              return internalError()
            }
            const barrier = await preflight(rootCtx, agent, operation, id)
            if (barrier !== undefined) {
              appendAudit(agent, actor, operation, 'failed', id, barrier.code)
              return barrier
            }
            notifyDurableChange()
            appendAudit(agent, actor, operation, 'allowed', id)
            return scheduleView(record, Date.now(), operation === 'resume')
          })
        },
        presentCall: args => present(operation === 'pause' ? 'Pause reminder' : 'Resume reminder', 'other', args.id),
      })))
    }

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_run_now',
      description: RUN_NOW_DESCRIPTION,
      parameters: {
        id: { type: 'string', required: true, description: 'Exact session-local schedule id.' },
      },
      output: { schema: RUN_NOW_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec): Promise<ScheduleRunNowValue> {
        if (args.id.length === 0 || args.id.trim() !== args.id) {
          return { code: 'invalid_rule', message: 'schedule_run_now id must be non-empty without surrounding whitespace.' }
        }
        const id = ScheduleId(args.id)
        if (exec.agent !== agent) return internalError()
        const actor = actorFor(access, agent)
        const approval = await requestWriteApproval(
          rootCtx,
          agent,
          'schedule_run_now',
          String(exec.callId),
          `Run Schedule reminder ${id} now.`,
          exec.signal,
        )
        if (!approval.allowed) {
          appendAudit(agent, actor, 'run_now', 'rejected', id, approval.error.code)
          return approval.error
        }
        return runCancellableScheduleTransaction(agent, exec.signal, async () => {
          const uncertain = await preflight(rootCtx, agent, 'run', id)
          if (uncertain !== undefined) return uncertain
          notifyDurableChange()
          const folded = foldForTool(agent)
          if (isToolError(folded)) return folded
          const record = recordById(folded, id)
          if (record === undefined) {
            const notFound: ScheduleManagementError = { code: 'schedule_not_found', message: 'No active reminder has this id.', id }
            appendAudit(agent, actor, 'run_now', 'failed', id, notFound.code)
            return notFound
          }
          const now = Date.now()
          const runId = randomUUID()
          const at = new Date(now).toISOString()
          let text: string
          try {
            text = record.kind === 'every'
              ? renderEveryReminderBatchFraming([{
                record,
                occurrenceAt: now >= Date.parse(record.scheduledAt)
                  ? resolveEveryOccurrence(record, now).occurrenceAt
                  : record.scheduledAt,
              }])
              : renderReminderFraming(record)
          } catch {
            appendAudit(agent, actor, 'run_now', 'failed', id, 'internal_error')
            return internalError()
          }
          const started = Date.now()
          try {
            agent.followup(createUserMessage({
              content: [{ type: 'text', text }],
              source: { kind: 'plugin', plugin: 'schedule' },
            }))
          } catch {
            appendAudit(agent, actor, 'run_now', 'failed', id, 'followup_failed')
            return internalError()
          }
          const durationMs = Math.max(0, Date.now() - started)
          try {
            agent.session.append('schedule/change', {
              version: 1,
              operation: 'run',
              run: { runId, scheduleId: id, at, status: 'triggered', trigger: 'manual', durationMs },
            })
          } catch {
            appendAudit(agent, actor, 'run_now', 'failed', id, 'internal_error')
            return internalError()
          }
          const barrier = await preflight(rootCtx, agent, 'run', id)
          if (barrier !== undefined) {
            appendAudit(agent, actor, 'run_now', 'failed', id, barrier.code)
            return barrier
          }
          notifyDurableChange()
          appendAudit(agent, actor, 'run_now', 'allowed', id)
          return { runId, id, status: 'triggered', at }
        })
      },
      presentCall: args => present('Run reminder now', 'other', args.id),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_logs',
      description: LOGS_DESCRIPTION,
      parameters: {
        id: { type: 'string', description: 'Optional exact session-local schedule id.' },
        session_id: { type: 'string', description: 'Optional other session id; administrators only.' },
        limit: { type: 'number', description: 'Maximum entries, 1 to 200; defaults to 20.' },
      },
      output: { schema: LOGS_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec): Promise<ScheduleLogsValue> {
        const limit = args.limit ?? 20
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
          return { code: 'invalid_limit', message: 'limit must be a safe integer from 1 to 200.' }
        }
        if (args.session_id !== undefined && args.session_id.length === 0) {
          return { code: 'invalid_rule', message: 'session_id must be non-empty.' }
        }
        if (exec.agent !== agent) return internalError()
        const id = args.id === undefined
          ? undefined
          : args.id.length === 0 || args.id.trim() !== args.id
            ? null
            : ScheduleId(args.id)
        if (id === null) {
          return { code: 'invalid_rule', message: 'schedule_logs id must be non-empty without surrounding whitespace.' }
        }
        const target = args.session_id === undefined ? undefined : SessionId(args.session_id)
        if (target === undefined || target === agent.session.id) {
          return runCancellableScheduleTransaction(agent, exec.signal, async () => {
            const uncertain = await preflight(rootCtx, agent, 'logs', id ?? undefined)
            if (uncertain !== undefined) return uncertain
            return scheduleRunLogs(agent.session.ownEvents(), 0, id ?? undefined).slice(0, limit)
          })
        }
        const role = callerRole(access)
        if (!canListAll(role)) return forbidden('Reading another session\'s Schedule logs requires an administrator role.')
        const owner = ownerForSession(access, target)
        if (role === 'dept_admin') {
          const ownDepartment = ownerForSession(access, agent.session.id).departmentCode
          if (ownDepartment === undefined || owner.departmentCode !== ownDepartment) {
            return forbidden('A department administrator may only read their own department.')
          }
        }
        const handle = await rootCtx.sessionPersistence.open(target, 'read', { signal: exec.signal })
        try {
          const read = await handle.read(0, undefined, { signal: exec.signal })
          return scheduleRunLogs(read.events, handle.inheritedEventCount, id ?? undefined).slice(0, limit)
        } finally {
          await handle.close()
        }
      },
      presentCall: args => present('Schedule run logs', 'read', args.id ?? args.session_id),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_list_all',
      description: LIST_ALL_DESCRIPTION,
      parameters: {
        department: { type: 'string', description: 'Optional department code filter.' },
        user: { type: 'string', description: 'Optional user id filter.' },
        limit: { type: 'number', description: 'Maximum reminders, 1 to 200; defaults to 50.' },
      },
      output: { schema: LIST_ALL_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec): Promise<ScheduleListAllValue> {
        if (exec.agent !== agent) return internalError()
        const limit = args.limit ?? 50
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
          return { code: 'invalid_limit', message: 'limit must be a safe integer from 1 to 200.' }
        }
        const role = callerRole(access)
        const own = ownerForSession(access, agent.session.id)
        const scope = listAllScope(role, own.departmentCode, args.department, args.user)
        if ('code' in scope) return scope
        const snapshots = await rootCtx.sessionPersistence.list({ signal: exec.signal })
        const rows: ScheduleListAllRow[] = []
        for (const snapshot of snapshots) {
          if (exec.signal.aborted) return internalError()
          const owner = ownerForSession(access, snapshot.header.id)
          if (scope.department !== undefined && owner.departmentCode !== scope.department) continue
          if (scope.user !== undefined && owner.userId !== scope.user) continue
          try {
            const handle = await rootCtx.sessionPersistence.open(snapshot.header.id, 'read', { signal: exec.signal })
            try {
              const read = await handle.read(0, undefined, { signal: exec.signal })
              const folded = foldScheduleEvents(read.events, handle.inheritedEventCount)
              const now = Date.now()
              for (const record of folded.active) {
                rows.push({
                  sessionId: snapshot.header.id,
                  owner,
                  schedule: scheduleView(record, now, !folded.paused.includes(record.id)),
                })
                if (rows.length >= limit) return rows
              }
            } finally {
              await handle.close()
            }
          } catch (error: unknown) {
            if (error instanceof ScheduleLogError) continue
            rootCtx.logger.warn(`schedule: cannot read session "${snapshot.header.id}" for list_all`)
          }
        }
        return rows
      },
      presentCall: () => present('List all reminders', 'read'),
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  let active = true
  return () => {
    if (!active) return
    active = false
    for (const dispose of disposers.reverse()) dispose()
  }
}
