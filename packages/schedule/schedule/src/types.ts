/**
 * Durable and model-facing Schedule value types.
 * @module @deepseek-ai/dsh-schedule
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session/types'

/** Stable reminder identity that is unique and never reused within one session. */
export type ScheduleId = Branded<'ScheduleId'>

/** Durable one-shot reminder created from a positive delay. */
export interface AfterScheduleRecord {
  /** Session-local stable identity. */
  readonly id: ScheduleId
  /** Rule discriminator for a delayed one-shot reminder. */
  readonly kind: 'after'
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Positive safe-integer delay accepted at creation. */
  readonly afterSeconds: number
  /** Four-digit-year RFC 3339 UTC target. */
  readonly scheduledAt: string
}

/** Durable one-shot reminder created from an absolute instant. */
export interface AtScheduleRecord {
  /** Session-local stable identity. */
  readonly id: ScheduleId
  /** Rule discriminator for an absolute one-shot reminder. */
  readonly kind: 'at'
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Four-digit-year RFC 3339 UTC target. */
  readonly scheduledAt: string
}

/** Durable fixed-rate reminder whose next target remains creation-anchor-aligned. */
export interface EveryScheduleRecord {
  /** Session-local stable identity. */
  readonly id: ScheduleId
  /** Rule discriminator for a fixed-rate recurring reminder. */
  readonly kind: 'every'
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Fixed safe-integer interval, never below five minutes. */
  readonly everySeconds: number
  /** Earliest anchor-aligned occurrence not yet dispatched. */
  readonly scheduledAt: string
}

/** Structured local-calendar input accepted by `schedule_create`. */
export interface LocalAtInput {
  /** Four-digit ISO calendar date. */
  readonly date: string
  /** Local wall-clock time with optional one-to-three digit milliseconds. */
  readonly time: string
  /** Explicit UTC or IANA Area/Location zone. */
  readonly time_zone: string
}

/** Absolute selector accepted by `schedule_create`. */
export type AtInput = string | LocalAtInput

/** One-shot record variants that terminate on an id-only dispatch. */
export type OneShotScheduleRecord = AfterScheduleRecord | AtScheduleRecord

/** The v1 durable reminder record union. */
export type ScheduleRecord = OneShotScheduleRecord | EveryScheduleRecord

/** Creates one durable reminder record. */
export interface ScheduleCreateChange {
  readonly version: 1
  readonly operation: 'create'
  readonly schedule: ScheduleRecord
}

/** Deletes one currently active reminder. */
export interface ScheduleDeleteChange {
  readonly version: 1
  readonly operation: 'delete'
  readonly id: ScheduleId
}

/** Records that one active one-shot reminder entered the durable dispatch history. */
export interface OneShotScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
}

/** Records one fixed-rate decision and advances directly past missed occurrences. */
export interface EveryScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
  /** Wall-clock decision time used to select the latest due occurrence. */
  readonly acceptedAt: string
}

/** Durable dispatch shapes supported by the current rule set. */
export type ScheduleDispatchChange = OneShotScheduleDispatchChange | EveryScheduleDispatchChange

/** Replaces one active record while preserving its identity and pause state. */
export interface ScheduleUpdateChange {
  readonly version: 1
  readonly operation: 'update'
  readonly schedule: ScheduleRecord
}

/** Pauses one active record without deleting it. */
export interface SchedulePauseChange {
  readonly version: 1
  readonly operation: 'pause'
  readonly id: ScheduleId
}

/** Resumes one paused record. */
export interface ScheduleResumeChange {
  readonly version: 1
  readonly operation: 'resume'
  readonly id: ScheduleId
}

/** How one durable run ended. */
export type ScheduleRunStatus = 'dispatched' | 'triggered' | 'failed'

/** One durable run-log entry; `run` changes never alter the active fold. */
export interface ScheduleRunRecord {
  /** Session-local run identity, stable for logs and receipts. */
  readonly runId: string
  /** Reminder that produced this run. */
  readonly scheduleId: ScheduleId
  /** Canonical UTC instant when the run was admitted. */
  readonly at: string
  readonly status: ScheduleRunStatus
  /** Whether the run came from the due clock or an explicit manual trigger. */
  readonly trigger: 'due' | 'manual'
  /** Contained failure detail; absent for an admitted run. */
  readonly error?: string
  /** Enqueue-to-receipt duration in milliseconds, when measured. */
  readonly durationMs?: number
}

/** Appends one run-log entry without changing active reminder state. */
export interface ScheduleRunChange {
  readonly version: 1
  readonly operation: 'run'
  readonly run: ScheduleRunRecord
}

/** Management action recorded for audit. */
export type ScheduleAuditAction = 'update' | 'pause' | 'resume' | 'run_now'

/** One durable audit entry for a management write attempt. */
export interface ScheduleAuditRecord {
  /** Session-local audit identity. */
  readonly auditId: string
  /** Stable actor label supplied by the deployment access configuration. */
  readonly actor: string
  readonly action: ScheduleAuditAction
  /** Target reminder; absent when the request was rejected before resolution. */
  readonly scheduleId?: ScheduleId
  readonly outcome: 'allowed' | 'rejected' | 'failed'
  /** Canonical UTC instant when the decision was recorded. */
  readonly at: string
  /** Short contained detail; never the reminder prompt. */
  readonly detail?: string
}

/** Appends one audit-log entry without changing active reminder state. */
export interface ScheduleAuditChange {
  readonly version: 1
  readonly operation: 'audit'
  readonly audit: ScheduleAuditRecord
}

/** Strict version-1 durable Schedule mutation union. */
export type ScheduleChange =
  | ScheduleCreateChange
  | ScheduleDeleteChange
  | ScheduleDispatchChange
  | ScheduleUpdateChange
  | SchedulePauseChange
  | ScheduleResumeChange
  | ScheduleRunChange
  | ScheduleAuditChange

/** Current delivery timing derived from the durable record and wall clock. */
export type ScheduleState = 'scheduled' | 'overdue'

/** Fixed v1 delivery boundary: the original session must be live. */
export type ScheduleDeliveryMode = 'session-local'

/** Complete model-facing view of one active reminder. */
export type ScheduleView = ScheduleRecord & {
  /** Whether the target remains in the future. */
  readonly state: ScheduleState
  /** Whether the reminder is paused and therefore will not fire. */
  readonly enabled: boolean
  /** Reminder delivery never leaves the owning session. */
  readonly deliveryMode: ScheduleDeliveryMode
}

/** Deployment role used by Schedule management authorization. */
export type ScheduleRole = 'super_admin' | 'admin' | 'dept_admin' | 'user'

/** One durable owner label attached to a Session's reminders. */
export interface ScheduleOwner {
  /** Stable deployment user identity. */
  readonly userId: string
  /** Display name when the deployment supplies one. */
  readonly userName?: string
  /** Department code used for department-scoped administration. */
  readonly departmentCode?: string
  /** Display name of the department. */
  readonly departmentName?: string
}

/** Optional deployment access configuration for Schedule management tools. */
export interface ScheduleAccessConfig {
  /** Caller role; defaults to `user` (own Session only). */
  readonly role?: ScheduleRole
  /** Owner label for Sessions without an explicit per-session override. */
  readonly owner?: ScheduleOwner
  /** Per-Session owner overrides for a Host shared by several users. */
  readonly sessionOwners?: readonly (ScheduleOwner & { readonly sessionId: string })[]
}

/** Management operations whose persistence barrier may be uncertain. */
export type SchedulePersistenceOperation =
  | 'create'
  | 'list'
  | 'delete'
  | 'get'
  | 'update'
  | 'pause'
  | 'resume'
  | 'run'
  | 'logs'
  | 'list_all'

/** Stable error returned for an empty reminder prompt. */
export interface InvalidPromptError {
  readonly code: 'invalid_prompt'
  readonly message: string
}

/** Stable error returned for a missing, conflicting, or unsupported rule selector. */
export interface InvalidSelectorError {
  readonly code: 'invalid_selector'
  readonly message: string
}

/** Stable error returned for an invalid rule or management argument. */
export interface InvalidRuleError {
  readonly code: 'invalid_rule'
  readonly message: string
}

/** Stable error returned for an invalid or unsupported IANA time zone. */
export interface InvalidTimeZoneError {
  readonly code: 'invalid_time_zone'
  readonly message: string
}

/** Stable error returned when an absolute target is not strictly future. */
export interface NotFutureError {
  readonly code: 'not_future'
  readonly message: string
}

/** Stable error returned when the computed instant cannot use a four-digit UTC year. */
export interface TimeOutOfRangeError {
  readonly code: 'time_out_of_range'
  readonly message: string
}

/** Stable error returned when a fixed-rate rule runs more often than supported. */
export interface FrequencyTooHighError {
  readonly code: 'frequency_too_high'
  readonly message: string
}

/** Stable error returned when the durable Schedule stream is malformed. */
export interface CorruptScheduleLogError {
  readonly code: 'corrupt_schedule_log'
  readonly message: string
}

/** Stable error returned when a required persistence checkpoint did not complete. */
export interface PersistenceUncertainError {
  readonly code: 'persistence_uncertain'
  readonly message: string
  readonly operation: SchedulePersistenceOperation
  readonly id?: ScheduleId
}

/** Stable fallback that does not disclose an internal exception. */
export interface InternalScheduleError {
  readonly code: 'internal_error'
  readonly message: string
}

/** Stable error returned when the caller lacks a required management role or scope. */
export interface ForbiddenScheduleError {
  readonly code: 'forbidden'
  readonly message: string
}

/** Stable error returned for an unknown or inactive reminder id. */
export interface ScheduleNotFoundError {
  readonly code: 'schedule_not_found'
  readonly message: string
  readonly id: ScheduleId
}

/** Stable error returned when a human rejected the write approval. */
export interface ScheduleApprovalRejectedError {
  readonly code: 'approval_rejected'
  readonly message: string
}

/** Stable error returned when no approval answerer is composed. */
export interface ScheduleApprovalUnavailableError {
  readonly code: 'approval_unavailable'
  readonly message: string
}

/** Stable error returned for a pause of an already paused reminder. */
export interface ScheduleAlreadyPausedError {
  readonly code: 'already_paused'
  readonly message: string
  readonly id: ScheduleId
}

/** Stable error returned for a resume of a reminder that is not paused. */
export interface ScheduleNotPausedError {
  readonly code: 'not_paused'
  readonly message: string
  readonly id: ScheduleId
}

/** Stable error returned for an update that names no change or conflicting changes. */
export interface ScheduleInvalidUpdateError {
  readonly code: 'invalid_update'
  readonly message: string
}

/** Stable error returned for an out-of-range log page size. */
export interface ScheduleInvalidLimitError {
  readonly code: 'invalid_limit'
  readonly message: string
}

/** Closed v1 Schedule management error union for the original create/list/delete tools. */
export type ScheduleToolError =
  | InvalidPromptError
  | InvalidSelectorError
  | InvalidRuleError
  | InvalidTimeZoneError
  | NotFutureError
  | TimeOutOfRangeError
  | FrequencyTooHighError
  | CorruptScheduleLogError
  | PersistenceUncertainError
  | InternalScheduleError

/** Management authorization and state errors added by the extended tools. */
export type ScheduleManagementError =
  | ForbiddenScheduleError
  | ScheduleNotFoundError
  | ScheduleApprovalRejectedError
  | ScheduleApprovalUnavailableError
  | ScheduleAlreadyPausedError
  | ScheduleNotPausedError
  | ScheduleInvalidUpdateError
  | ScheduleInvalidLimitError

/** One recent run exposed by `schedule_get` and `schedule_logs`. */
export interface ScheduleRunLogEntry {
  readonly runId: string
  readonly scheduleId: ScheduleId
  readonly at: string
  readonly status: ScheduleRunStatus
  readonly trigger: 'due' | 'manual'
  readonly error?: string
  readonly durationMs?: number
}

/** Canonical `schedule_create` value. */
export type ScheduleCreateValue = ScheduleView | ScheduleToolError

/** Canonical `schedule_list` value. */
export type ScheduleListValue = ScheduleView[] | ScheduleToolError

/** Canonical `schedule_get` value, including the latest durable run when present. */
export type ScheduleGetValue = (ScheduleView & { readonly lastRun?: ScheduleRunLogEntry }) | ScheduleToolError | ScheduleManagementError

/** Canonical `schedule_update`, `schedule_pause`, and `schedule_resume` value. */
export type ScheduleManageValue = ScheduleView | ScheduleToolError | ScheduleManagementError

/** Successful `schedule_run_now` receipt. */
export interface ScheduleRunReceipt {
  readonly runId: string
  readonly id: ScheduleId
  readonly status: 'triggered'
  readonly at: string
}

/** Canonical `schedule_run_now` value. */
export type ScheduleRunNowValue = ScheduleRunReceipt | ScheduleToolError | ScheduleManagementError

/** Canonical `schedule_logs` value, newest run first. */
export type ScheduleLogsValue = ScheduleRunLogEntry[] | ScheduleToolError | ScheduleManagementError

/** One cross-Session roster row returned by `schedule_list_all`. */
export interface ScheduleListAllRow {
  readonly sessionId: SessionId
  readonly owner: ScheduleOwner
  readonly schedule: ScheduleView
}

/** Canonical `schedule_list_all` value. */
export type ScheduleListAllValue = ScheduleListAllRow[] | ScheduleToolError | ScheduleManagementError

/** Successful `schedule_delete` value, including the non-mutating not-found result. */
export type ScheduleDeleteResult =
  | { readonly id: ScheduleId; readonly deleted: true }
  | { readonly id: ScheduleId; readonly deleted: false; readonly code: 'schedule_not_found' }

/** Canonical `schedule_delete` value. */
export type ScheduleDeleteValue = ScheduleDeleteResult | ScheduleToolError

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Versioned Schedule mutation. The owning package validates the complete
     * session-local transition stream before accepting a candidate event.
     */
    'schedule/change': ScheduleChange
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Complete active reminders owned by this Session's post-fork suffix. */
    schedule: readonly ScheduleRecord[]
  }
}
