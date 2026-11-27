/**
 * Knowledge-base Client plugin.
 *
 * Registers three official DSH surfaces:
 * - `sidebar.panellist` gives the left-sidebar menu entry.
 * - The matching `main` key gives the management page the entry selects. The
 *   page replaces the conversation area and carries its own master-detail
 *   layout: a menu and the knowledge tree on the left, a content region on the
 *   right.
 * - `settings.section` gives the connection and status page.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { KnowledgeSettingsSection } from './KnowledgeSettingsSection.tsx'
import type { KnowledgeSettingsInjected } from './KnowledgeSettingsSection.tsx'
import { KnowledgePanel } from './KnowledgePanel.tsx'
import { sanitizeExplorerTabs } from './sanitizeExplorerTabs.ts'
import type { KnowledgePanelInjected, SessionSource } from './KnowledgePanel.tsx'
import { KnowledgeMenuIcon } from './KnowledgeMenuIcon.tsx'
import { registerSaveAudit, setActorResolver, setMountPointResolver } from './saveAudit.ts'
import { en, zh, type KnowledgeKey } from './locales.ts'
import { WorkflowPlaza, type WorkflowPlazaInjected } from './workflows/WorkflowPlaza.tsx'
import { createSettingsGate } from './settingsGate.ts'
import { workflowPlazaDeps, type ScheduleCatalogRow } from './workflows/deps.ts'
import { subscriptionPrompt } from './workflows/subscribe.ts'
import type { RawModelCatalog, WorkflowModelSelection } from './workflows/modelChoice.ts'
import { findWorkflow } from './workflows/registry.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.knowledgeBase': KnowledgeKey

  }

  /**
   * The workflow-plaza seat inside the automation-task page.
   *
   * That page belongs to `ui-schedule`, which this plugin cannot extend at build time
   * (the running Host ships it as a built bundle). The seat is declared here as a
   * type-level contract and contributed at runtime: if the deployed page does not
   * declare the child slot, the registration simply never renders, and every other
   * knowledge surface is unaffected.
   *
   * `single` = one tab id shows one body; `root` = the task page is root-scoped and a
   * plaza belongs to no Session.
   */
  interface SlotMap {
    'schedule.manager.tabs': {
      kind: 'single'
      scope: 'root'
      owner: Record<string, never>
      hookContext: unknown
      inject: WorkflowPlazaInjected
    }
    /**
     * Header actions contributed by another plugin (the DataOps notification bell).
     * This plugin declares and renders the seat; it never imports the contributor.
     */
    'workflow-plaza.actions': {
      kind: 'single'
      scope: 'root'
      owner: Record<string, never>
      hookContext: unknown
    }
  }
}

const NS = 'settings.knowledgeBase'

/**
 * The knowledge root, reported by the panel once it knows it.
 *
 * The save-audit registration lives here, before any page mounts, because it
 * must exist even when the knowledge page is closed -- an edit in the sidebar
 * is still a knowledge-base edit. The panel is what reads the mount point, so
 * it publishes the value here rather than the registration fetching it twice.
 */
let mountPoint = ''

/**
 * Panel id shared by the list entry and the `main` slot it selects.
 *
 * The ui-sidebar contract resolves a missing panel by throwing and keeping the
 * current selection, so these two registrations must always ship together.
 */
const PANEL_ID = 'knowledge-base'

/** Slot key for the plaza's own page; distinct from the knowledge panel's key. */

/**
 * Client services required for these contributions.
 *
 * `sessions` and `workspaces` are here because the `@`-reference dialog inserts into a
 * conversation draft, and that insert resolves the target session's scope through
 * `ctx.sessions` before it can write anything. Without the injection the service is not
 * on this plugin's ctx at all: the call throws `cannot get property "sessions" without
 * inject`, `referenceInChat` catches it into a `console.warn`, and the reader sees a
 * dialog that closes and inserts nothing -- the exact "clicked, nothing happened"
 * symptom this injection fixes at the root rather than by reporting the failure.
 *
 * `workspaces` is the other half: the mention is spelled relative to the workspace that
 * owns the session, so the insert needs that root to project the path.
 */
/**
 * Build the plaza's Host wiring from the client services this plugin can reach.
 *
 * Two details are easy to get wrong and are handled here rather than in the view:
 *
 * 1. **A new Session needs a moment before it accepts a prompt.** `create()` resolves
 *    once the Session is addressable, but the scope's conversation face can still be
 *    missing for a tick. The prompt is retried a few times instead of failing on the
 *    first refusal -- the "wait for composer readiness" trap.
 * 2. **The catalog is the only cross-Session read.** `remote.schedule.list` is scoped
 *    to one Session, so it cannot answer "is this workflow already subscribed"; the
 *    catalog can, and it is also what the automation page itself renders from.
 *
 * @param ctx - client root context carrying `sessions` and `remote`.
 * @returns dependencies for {@link WorkflowPlaza}.
 */
function createWorkflowPlazaDeps(ctx: ClientContext) {
  const sessions = ctx.get('sessions') as unknown as
    | {
      create: (options?: { cwd?: string }) => Promise<string>
      /**
       * Retain one Session and run a callback against its reference. This is the only
       * documented way to reach a Session's prompt face from another plugin: `scope()`
       * returns the Agent context of an ALREADY OPENED session, and a just-created one
       * is not in that map yet.
       */
      using: <T>(
        id: string,
        options: { source: string },
        operation: (reference: {
          readonly ready: Promise<unknown>
          readonly binding: {
            readonly session: {
              prompt: (content: unknown[], mode: 'queue' | 'steer') => Promise<{ ok: boolean }>
              /** Turn state and the last agent error, so a failed attempt can name its cause. */
              getSnapshot: () => {
                readonly lastAgentError: string | null
                readonly promptError: { readonly message?: string } | null
              }
            }
          }
          release: () => void
        }) => Promise<T>,
      ) => Promise<T>
      open?: (id: string) => void
    }
    | undefined
  const uiWorkspace = ctx.get('uiWorkspace') as
    | { openSession?: (sessionId: string) => void }
    | undefined
  const remote = ctx.get('remote') as
    | {
      schedule?: { catalog: () => Promise<{ ok: boolean; value?: readonly ScheduleCatalogRow[] }>; delete: (request: { id: string; sessionId: string }) => Promise<{ ok: boolean }> }
      session?: {
        modelCatalog: () => Promise<{ ok: boolean; value?: RawModelCatalog }>
        selectModel: (request: {
          sessionId: string
          provider: string
          model: string
          reasoningEffort?: string
        }) => Promise<{ ok: boolean }>
      }
    }
    | undefined

  /** Same-origin call to the Host's workflow-plaza routes. */
  const callWorkflowRoute = async (method: string, body: Record<string, unknown> = {}): Promise<unknown> => {
    // Resolve against the document base so a deployment under a path prefix
    // (the serves the DSH at /dsh/) keeps the plugin's Host routes.
    // A base without a trailing slash would resolve the relative URL against the
    // parent path and drop the's `/dsh` prefix, so pin the trailing slash.
    const base = document.baseURI.endsWith('/') ? document.baseURI : `${document.baseURI}/`
    const response = await fetch(new URL(`knowledge-base/api/${method}`, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`${method} failed: ${String(response.status)}`)
    return response.json()
  }

  return workflowPlazaDeps({
    createSession: async (): Promise<string> => {
      if (sessions === undefined) throw new Error('sessions service unavailable')
      return sessions.create({})
    },
    sendPrompt: async (sessionId: string, text: string): Promise<boolean> => {
      if (sessions === undefined) return false
      // A newly created Session has no scope entry yet -- `scope(id)` reads a map that
      // is only populated once the Session is opened -- so the prompt must go through
      // `retain`, which starts (and awaits) that opening. `using` releases the
      // reference even when the send throws.
      try {
        return await sessions.using(sessionId, { source: 'controllerOperation' }, async reference => {
          await reference.ready
          const result = await reference.binding.session.prompt([{ type: 'text', text }], 'queue')
          return result.ok === true
        })
      } catch {
        return false
      }
    },
    readCatalog: async () => {
      if (remote?.schedule === undefined) return { ok: false }
      return remote.schedule.catalog()
    },
    deleteSchedule: async (taskId: string, sessionId: string) => {
      if (remote?.schedule === undefined) return { ok: false }
      // `ScheduleDeleteRequest` extends `ScheduleListRequest`, so the call carries the
      // owning Session as well as the task id: a Schedule belongs to the Session that
      // created it, and the Host routes the deletion through that binding.
      return remote.schedule.delete({ id: taskId, sessionId })
    },
    // Verification used to poll the catalog for ten seconds and call it "not created"
    // while the model was still working. The turn state is the honest signal: an error
    // ends the attempt immediately with its message, and a running turn keeps waiting.
    readSessionFailure: async (sessionId: string): Promise<string | undefined> => {
      if (sessions === undefined) return undefined
      try {
        return await sessions.using(sessionId, { source: 'controllerOperation' }, async reference => {
          await reference.ready
          const snapshot = reference.binding.session.getSnapshot()
          if (snapshot.lastAgentError !== null && snapshot.lastAgentError !== '') return snapshot.lastAgentError
          return snapshot.promptError?.message
        })
      } catch {
        return undefined
      }
    },
    // `sessions.open` is not a navigation API (it does not exist on the service);
    // `uiWorkspace.openSession` is the UI action that switches the main area from a
    // panel page to the Session's Conversation. Fall back only when uiWorkspace is
    // absent, so a profile without it still closes the dialog after a subscription.
    ...(uiWorkspace?.openSession === undefined
      ? (sessions?.open === undefined ? {} : { openSession: (id: string) => { sessions.open?.(id) } })
      : { openSession: (id: string) => { uiWorkspace.openSession?.(id) } }),
    ...(remote?.session === undefined
      ? {}
      : {
        readModelCatalog: async () => remote.session!.modelCatalog(),
        selectSessionModel: async (sessionId: string, selection: WorkflowModelSelection) => {
          const result = await remote.session!.selectModel({ sessionId, ...selection })
          return result.ok === true
        },
      }),
    readReviewAccess: async () => {
      try {
        const status = await callWorkflowRoute('status') as { canReviewWorkflows?: unknown }
        return status.canReviewWorkflows === true
      } catch {
        return false
      }
    },
    readPublished: async () => {
      try {
        return { ok: true, value: await callWorkflowRoute('workflow.public') as { workflows: never[] } }
      } catch {
        return { ok: false }
      }
    },
    readPending: async () => {
      try {
        return { ok: true, value: await callWorkflowRoute('workflow.pending') as { workflows: never[] } }
      } catch {
        return { ok: false }
      }
    },
    reviewWorkflow: async (id: string, decision: 'approve' | 'reject', note?: string) => {
      try {
        await callWorkflowRoute('workflow.review', {
          id,
          decision,
          ...(note === undefined ? {} : { note }),
        })
        return true
      } catch {
        return false
      }
    },
    readMine: async () => {
      try {
        return { ok: true, value: await callWorkflowRoute('workflow.mine') as { workflows: never[] } }
      } catch {
        return { ok: false }
      }
    },
    unpublishMine: async (id: string) => {
      try {
        await callWorkflowRoute('workflow.unpublish', { id })
        return true
      } catch {
        return false
      }
    },
    resubmitMine: async (id: string) => {
      try {
        await callWorkflowRoute('workflow.resubmit', { id })
        return true
      } catch {
        return false
      }
    },
  })
}

export const inject = [
  'slots', 'locale', 'uiSession', 'sessions', 'workspaces', 'uiWorkspace',
  // The workflow plaza reads and deletes Schedules. Cordis resolves a service proxy
  // lazily, so touching `remote.schedule` without declaring it throws
  // "cannot get property \"remote.schedule\" without inject" at call time rather than
  // at load -- which is why this only surfaced when a subscription was attempted.
  'remote', 'remote.schedule', 'remote.session',
]

/**
 * Register the knowledge-base navigation entry and Settings section.
 * @param ctx - DSH client context with locale and slot registries.
 */
export function apply(ctx: ClientContext): void {
  // One-way cleanup for layouts persisted before the placeholder was removed.
  sanitizeExplorerTabs()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'knowledge-base: copy')
  const t = ctx.locale.bind(NS) as KnowledgeSettingsInjected['t']

  // The Settings section is an operator surface, not a reader feature. The gate
  // watches the DataOps role broadcast and disposes/registers the section as the
  // caller changes; an unauthorized account never mounts its content at all.
  ctx.slots.inject('settings.section', () => {
    const gate = createSettingsGate({
      register: () => ctx.slots.register({
        name: 'settings.section',
        id: PANEL_ID,
        order: 35,
        label: () => t('nav'),
        inject: () => ({ t }),
      }, KnowledgeSettingsSection),
    })
    gate.start()
    return () => { gate.stop() }
  })

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    label: () => t('nav'),
  }, KnowledgeMenuIcon))

  // ── 工作流广场 ──
  //
  // Contributed into the automation-task page as a fourth tab, through the
  // `schedule.manager.tabs` seat that page declares. Nothing here creates schedules:
  // a subscription opens a Session and asks the model to call `schedule_create`, which
  // is the same path the product's own 「新建任务」 button takes. The knowledge plugin
  // supplies the templates and the Session plumbing; DSH supplies the scheduling.
  //
  // The seat lives on a page this plugin does not own, so the registration is written
  // to be harmless if that page ever drops the child declaration: an unknown slot
  // simply never renders, and no other knowledge surface changes.
/**
 * The plaza surface handed to every seat it mounts in: the automation page's
 * `schedule.manager.tabs` seat and this plugin's own page. Shared rather than
 * duplicated so the two entry points cannot drift apart.
 */
function createPlazaInjected(ctx: ClientContext): WorkflowPlazaInjected {
  return {
    copy: {
      title: t('workflowPlaza'),
      subscribe: t('workflowSubscribe'),
      subscribed: t('workflowSubscribed'),
      unsubscribe: t('workflowUnsubscribe'),
      frequency: t('workflowFrequency'),
      daily: t('workflowDaily'),
      weekly: t('workflowWeekly'),
      monthly: t('workflowMonthly'),
      custom: t('workflowCustom'),
      cronLabel: t('workflowCronLabel'),
      cronInvalid: t('workflowCronInvalid'),
      everyHours: t('workflowEveryHours'),
      everyMinutes: t('workflowEveryMinutes'),
      hoursCount: t('workflowHoursCount'),
      minutesCount: t('workflowMinutesCount'),
      cronReason: () => t('workflowCronInvalid'),
      intervalInvalid: (min: number, max: number) => t('workflowIntervalInvalid')
        .replace('{min}', String(min))
        .replace('{max}', String(max)),
      subscribing: t('workflowSubscribing'),
      plazaTab: t('workflowPlazaTab'),
      reviewTab: t('workflowReviewTab'),
      reviewEmpty: t('workflowReviewEmpty'),
      mineTab: t('workflowMineTab'),
      mineEmpty: t('workflowMineEmpty'),
      mineUpdated: t('workflowMineUpdated'),
      mineReviewNote: t('workflowMineReviewNote'),
      mineResubmit: t('workflowMineResubmit'),
      mineUnpublish: t('workflowMineUnpublish'),
      mineDetails: t('workflowMineDetails'),
      mineActionFailed: t('workflowMineActionFailed'),
      mineStatusPending: t('workflowMineStatusPending'),
      mineStatusApproved: t('workflowMineStatusApproved'),
      mineStatusRejected: t('workflowMineStatusRejected'),
      mineStatusUnpublished: t('workflowMineStatusUnpublished'),
      mineScopeGlobal: t('workflowMineScopeGlobal'),
      mineScopePrivate: t('workflowMineScopePrivate'),
      mineScopeDepartment: (name: string) => t('workflowMineScopeDepartment').replace('{name}', name),
      reviewLoading: t('workflowReviewLoading'),
      reviewFailed: t('workflowReviewFailed'),
      reviewAuthor: t('workflowReviewAuthor'),
      reviewCreated: t('workflowReviewCreated'),
      reviewPromptLabel: t('workflowReviewPrompt'),
      reviewNotePlaceholder: t('workflowReviewNote'),
      reviewApprove: t('workflowReviewApprove'),
      reviewReject: t('workflowReviewReject'),
      model: t('workflowModel'),
      modelLoading: t('workflowModelLoading'),
      modelUnavailable: t('workflowModelUnavailable'),
      modelDefault: t('workflowModelDefault'),
      effort: t('workflowEffort'),
      dialogTitle: t('workflowDialogTitle'),
      dialogConfirm: t('workflowDialogConfirm'),
      dialogCancel: t('workflowDialogCancel'),
      retry: t('workflowRetry'),
      alreadySubscribed: t('workflowAlreadySubscribed'),
      // The dictionary resolver takes one argument, so the placeholder is filled here.
      failure: reason => t('workflowSubscribeFailed').replace('{reason}', reason),
      reason: failure => t(`workflowReason${
        failure === 'already-subscribed' ? 'Already'
        : failure === 'session-failed' || failure === 'session-unaddressable' ? 'Session'
        : failure === 'prompt-failed' ? 'Prompt'
        : failure === 'model-failed' ? 'Model'
        : failure === 'cancel-failed' ? 'Cancel'
        : 'NotCreated'
      }` as Parameters<typeof t>[0]),
      cardTitle: workflow => workflow.title ?? t(`workflow${
        workflow.id === 'kb-organize-personal' ? 'Organize'
        : workflow.id === 'kb-index-personal' ? 'Index'
        : 'Archive'
      }Title` as Parameters<typeof t>[0]),
      cardDescription: workflow => workflow.description ?? t(`workflow${
        workflow.id === 'kb-organize-personal' ? 'Organize'
        : workflow.id === 'kb-index-personal' ? 'Index'
        : 'Archive'
      }Description` as Parameters<typeof t>[0]),
    },
    deps: createWorkflowPlazaDeps(ctx),
  }
}

  // The automation page's tab seat is contributed at runtime; when the deployed page
  // does not declare it this registration is inert. The standalone panel below is the
  // guaranteed entry point, so the plaza is never invisible on an older Host.
  // Exactly one entry owns the `workflow-plaza.actions` child slot. The inject
  // callback can run again when the automation page redeclares its tab seat; the
  // previous entry must be removed first, otherwise its child declaration is still
  // on the ledger and the next register throws "already declared".
  let disposeTabPlaza: (() => void) | undefined
  ctx.slots.inject('schedule.manager.tabs', () => {
    disposeTabPlaza?.()
    const dispose = ctx.slots.register({
      name: 'schedule.manager.tabs',
      locale: NS,
      inject: () => createPlazaInjected(ctx),
      children: { 'workflow-plaza.actions': { kind: 'single', scope: 'root' } },
    }, WorkflowPlaza)
    disposeTabPlaza = dispose
    return () => {
      dispose()
      if (disposeTabPlaza === dispose) disposeTabPlaza = undefined
    }
  })

  // The management page needs the caller's session to scope the file tree, and the
  // root-scoped `main` slot supplies no props. `uiSession.adapter.current` is the
  // published binding whose `key` is the session the main view is showing.
  //
  // Reading it once at inject time is not enough, because the value becomes
  // available only after a Workspace is chosen, which regularly happens AFTER this
  // page is first mounted: a page that sampled it once showed "No session
  // selected." forever and the file tree never appeared. Measured in a browser on
  // 2026-10-15 against a profile whose workspace list was still empty.
  //
  // The observable itself is handed to the component, which subscribes with
  // `useSyncExternalStore`. Re-reading inside `inject` would not help on its own:
  // the slot caches the injected value, so a later change has to reach React
  // through a subscription rather than through a fresh read.
  const currentSession = ctx.uiSession.adapter.current

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    // `main` is root-scoped, so the slot passes no locale-bound copy of its own;
    // the page gets the namespace's resolver plus the session source.
    inject: (): KnowledgePanelInjected => ({
      t: (key: string) => t(key as Parameters<typeof t>[0]),
      // The active locale id, so dates and relative spans render in the reader's
      // language rather than the machine's.
      locale: ctx.locale.getSnapshot().active,
      sessionSource: currentSession as SessionSource,
      // The tree's `@` helper takes the context itself, since it resolves the
      // workspace root and the draft service at click time.
      ctx,
    }),

  }, KnowledgePanel))

    // Join the sidebar editor's save events.
    //
    // Documents are edited in the host's own file window, so their saves never
    // pass through a knowledge-base route. Registering here -- once per plugin
    // load, not per page -- is what keeps the audit trail complete without the
    // editor knowing this plugin exists. The panel publishes both resolvers as it
    // loads: the mount point because the page already reads it, the actor because
    // the page's status call is what resolves the DataOps identity.
    setMountPointResolver(() => mountPoint)
    ctx.effect(() => registerSaveAudit(ctx), 'knowledge-base: editor save audit')
}
