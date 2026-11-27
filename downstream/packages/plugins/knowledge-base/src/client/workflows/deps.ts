/**
 * Wiring the workflow plaza to the Host's real services.
 *
 * Split out from the component so the component stays a pure view: everything that
 * touches sessions or Schedules lives here, and the orchestration in `subscribe.ts`
 * only ever sees plain functions.
 *
 * ## The asymmetry this module exists to absorb
 *
 * DSH exposes Schedules to the browser as READ and DELETE only; creating one is an
 * agent tool (`schedule_create`). So "is this workflow already subscribed" is answered
 * from `remote.schedule.catalog()`, "unsubscribe" is `remote.schedule.delete`, and
 * "subscribe" is a prompt into a new Session. That is not a shortcut taken here: the
 * task manager page documents the same design ("The page deliberately has no creation
 * form of its own").
 *
 * `remote.schedule.list` is deliberately NOT used: it is scoped to one Session
 * (`{ sessionId }`), so it cannot answer "does any task already represent this
 * workflow". `catalog()` is the cross-Session read and is what deduplication needs.
 *
 * @module @sparkelf/dsh-knowledge-base/client/workflows/deps
 */

import type { WorkflowPlazaDeps } from './WorkflowPlaza.tsx'
import type { SubscribedTaskView } from './dedupe.ts'
import type { PublishedWorkflowView } from './published.ts'
import {
  toWorkflowModelCatalog,
  type RawModelCatalog,
  type WorkflowModelSelection,
} from './modelChoice.ts'

/** One Schedule row as the catalog reports it, narrowed to what dedupe reads. */
export interface ScheduleCatalogRow {
  readonly id: string
  /** Session that owns the task; required to delete it. */
  readonly sessionId?: string
  /** The standing instruction this task delivers; the marker lives here. */
  readonly prompt?: string
  /** Human title, when the row carries one. */
  readonly name?: string
}

/** The parts of a remote result this module reads. */
interface RemoteResultLike<T> {
  readonly ok: boolean
  readonly value?: T
}

/**
 * The narrow slice of DSH client services this module needs.
 *
 * Typed structurally rather than importing the concrete service classes, so a test can
 * pass plain objects and a Host upgrade that reshapes a class does not silently change
 * what this file promises.
 */
export interface WorkflowPlazaHost {
  /** Create a Session in the current workspace; resolves its id. */
  readonly createSession: () => Promise<string>
  /** Send one text prompt into an existing Session; resolves false when refused. */
  readonly sendPrompt: (sessionId: string, text: string) => Promise<boolean>
  /** Read every retained task, across Sessions. */
  readonly readCatalog: () => Promise<RemoteResultLike<readonly ScheduleCatalogRow[]>>
  /** Delete one task by id. */
  readonly deleteSchedule: (taskId: string, sessionId: string) => Promise<RemoteResultLike<unknown>>
  /**
   * Read the Session's own turn failure, once it has one.
   *
   * Optional because only a Host holding the `sessions` service can answer it; a caller
   * without that wiring keeps the plain verification poll.
   */
  readonly readSessionFailure?: (sessionId: string) => Promise<string | undefined>
  /** Focus an existing Session, used to explain a failed attempt. */
  readonly openSession?: (sessionId: string) => void
  /** Read the Host model catalog, grouped by provider. */
  readonly readModelCatalog?: () => Promise<RemoteResultLike<RawModelCatalog>>
  /** Install one model selection on a Session before its first prompt. */
  readonly selectSessionModel?: (sessionId: string, selection: WorkflowModelSelection) => Promise<boolean>
  /** Approved published workflows. */
  readonly readPublished?: () => Promise<RemoteResultLike<{ workflows: readonly PublishedWorkflowView[] }>>
  /** Whether the caller may review pending workflows. */
  readonly readReviewAccess?: () => Promise<boolean>
  /** Pending workflows for the review tab. */
  readonly readPending?: () => Promise<RemoteResultLike<{ workflows: readonly PublishedWorkflowView[] }>>
  /** Approve or reject one pending workflow. */
  readonly reviewWorkflow?: (id: string, decision: 'approve' | 'reject', note?: string) => Promise<boolean>
  /** The caller's own shared workflows. */
  readonly readMine?: () => Promise<RemoteResultLike<{ workflows: readonly PublishedWorkflowView[] }>>
  /** Unpublish one of the caller's workflows. */
  readonly unpublishMine?: (id: string) => Promise<boolean>
  /** Resubmit one rejected/unpublished workflow. */
  readonly resubmitMine?: (id: string) => Promise<boolean>
}

/**
 * Build the plaza's dependencies from Host services.
 *
 * Both reads are total: a failed remote call becomes an empty-or-unchanged answer the
 * caller can react to, never a thrown error inside a render.
 *
 * @param host - the wiring described by {@link WorkflowPlazaHost}.
 * @returns dependencies the plaza and its orchestration consume.
 */
export function workflowPlazaDeps(host: WorkflowPlazaHost): WorkflowPlazaDeps {
  return {
    listTasks: async (): Promise<readonly SubscribedTaskView[]> => {
      const result = await host.readCatalog()
      if (!result.ok || result.value === undefined) {
        // Throwing rather than returning [] is deliberate: `subscribeWorkflow` treats a
        // failed read as "not evidence of absence" and refuses to create. Returning an
        // empty list here would tell it "nothing is subscribed" and let a duplicate
        // through exactly when the Host is least healthy.
        throw new Error('schedule catalog unavailable')
      }
      return result.value.map(row => ({
        id: row.id,
        ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
        ...(row.prompt === undefined ? {} : { prompt: row.prompt }),
        ...(row.name === undefined ? {} : { name: row.name }),
      }))
    },
    createSession: host.createSession,
    sendPrompt: host.sendPrompt,
    removeTask: async (taskId: string, sessionId: string): Promise<boolean> => {
      const result = await host.deleteSchedule(taskId, sessionId)
      return result.ok
    },
    ...(host.readSessionFailure === undefined ? {} : { readSessionFailure: host.readSessionFailure }),
    ...(host.openSession === undefined ? {} : { openSession: host.openSession }),
    ...(host.readModelCatalog === undefined
      ? {}
      : {
        loadModels: async () => {
          const result = await host.readModelCatalog!()
          if (!result.ok || result.value === undefined) throw new Error('model catalog unavailable')
          return toWorkflowModelCatalog(result.value)
        },
      }),
    ...(host.selectSessionModel === undefined ? {} : { selectModel: host.selectSessionModel }),
    ...(host.readPublished === undefined
      ? {}
      : {
        loadPublished: async () => {
          const result = await host.readPublished!()
          if (!result.ok || result.value === undefined) return []
          return result.value.workflows
        },
      }),
    ...(host.readReviewAccess === undefined ? {} : { loadReviewAccess: host.readReviewAccess }),
    ...(host.readPending === undefined
      ? {}
      : {
        loadPending: async () => {
          const result = await host.readPending!()
          if (!result.ok || result.value === undefined) throw new Error('pending workflows unavailable')
          return result.value.workflows
        },
      }),
    ...(host.reviewWorkflow === undefined ? {} : { reviewPublished: host.reviewWorkflow }),
    ...(host.readMine === undefined
      ? {}
      : {
        loadMine: async () => {
          const result = await host.readMine!()
          if (!result.ok || result.value === undefined) throw new Error('mine unavailable')
          return result.value.workflows
        },
      }),
    ...(host.unpublishMine === undefined ? {} : { unpublishMine: host.unpublishMine }),
    ...(host.resubmitMine === undefined ? {} : { resubmitMine: host.resubmitMine }),
  }
}
