/**
 * Carry a top-level session's model choice into the composition default.
 *
 * DSH's model selector writes a session-local `model/selection` event. A new
 * session is offered `agentDefaultModel.currentSelection()` instead, and that value
 * comes from the `agent-default-model` profile entry — a different document. The
 * shipped controller already forwards an explicit `session.selectModel` call to
 * `agentDefaultModel.saveSelection()`, but that write needs the `configEditor`
 * service: a composition without it (or one whose write is shadowed by a patch
 * layer) keeps the old default silently, which reads to the user as "the model
 * selector does not stick".
 *
 * This plugin closes that gap on the durable event itself rather than on one RPC
 * entry point: every `model/selection` append on a top-level session schedules a
 * write to the same `agent-default-model` entry the selector's default is read
 * from. Subagent and fork children carry `parentSession` in their header and are
 * ignored, so delegating work never rewrites the user's default.
 *
 * Two properties are deliberate:
 *
 * - The listener only schedules. `session/event` runs inside the appending
 *   session's publication window, where a nested append throws; the write itself
 *   lands after a short debounce, outside that window, and only the last selection
 *   of a burst is persisted.
 * - The write is skipped when the live default already equals the selection. The
 *   shipped controller may have written it a moment earlier, and a redundant
 *   config-editor edit would reload the profile for nothing.
 *
 * The plugin reads both services through optional lookups and declares no runtime
 * import beyond its own module, so it mounts on a composition with or without the
 * settings/config-editor pair and needs no version lockstep with the packages it
 * touches.
 *
 * @module @sparkelf/dsh-dataops-model-default
 */
import type { Context } from '@deepseek-ai/cordis'

/** The profile entry (settings namespace) owned by `@deepseek-ai/dsh-agent-default-model`. */
export const NAMESPACE = 'agent-default-model'

/**
 * Quiet window that collapses a burst of selections into one profile write, and long
 * enough for the controller's own save (the same write, issued from `selectModel`) to
 * land first. The follow-up check then sees it and skips a redundant profile reload.
 */
export const PERSIST_DELAY_MS = 1000

/** One complete provider/model/effort triple, as the default-model entry stores it. */
export interface Selection {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort; absent follows the provider default. */
  reasoningEffort?: string
}

/** The `session/event` payload fields this plugin reads. */
export interface SessionEventLike {
  type?: unknown
  data?: unknown
}

/** The session header fields this plugin reads. */
export interface SessionLike {
  header?: { parentSession?: unknown }
}

/** The `agentDefaultModel` service face used here. */
interface DefaultModelFace {
  currentSelection(): Selection
  saveSelection(next: Selection): Promise<void>
}

/** The `settings` service face used here. */
interface SettingsFace {
  update(ns: string, patch: Record<string, unknown>): Promise<void>
}

/** A logger with the three levels the harness context provides. */
interface LoggerFace {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

/** The context surface this plugin uses; services are looked up, never required. */
interface HostContext {
  get(name: string): unknown
  on(name: string, listener: (session: SessionLike, event: SessionEventLike) => void): () => void
  effect(setup: () => () => void, label: string): void
  logger?: LoggerFace
}

/** Whether a session is a top-level conversation rather than a subagent or fork child. */
export function isTopLevelSession(session: SessionLike): boolean {
  return session.header?.parentSession === undefined
}

/**
 * Read a persisted selection out of one session event.
 * @param event - the appended event, exactly as recorded.
 * @returns the selection when the event is a well-formed `model/selection`, otherwise undefined.
 */
export function selectionOf(event: SessionEventLike): Selection | undefined {
  if (event.type !== 'model/selection') return undefined
  if (event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)) return undefined
  const data = event.data as Record<string, unknown>
  const { provider, model, reasoningEffort } = data
  if (typeof provider !== 'string' || provider === '') return undefined
  if (typeof model !== 'string' || model === '') return undefined
  if (reasoningEffort === undefined || reasoningEffort === null) return { provider, model }
  if (typeof reasoningEffort !== 'string' || reasoningEffort === '') return undefined
  return { provider, model, reasoningEffort }
}

/** Whether two selections address the same route and effort. */
export function sameSelection(left: Selection, right: Selection): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && (left.reasoningEffort ?? undefined) === (right.reasoningEffort ?? undefined)
}

/** Project a selection onto the settings document shape (omitting an absent effort). */
function configOf(selection: Selection): Record<string, unknown> {
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  }
}

/** Format one selection for the log. */
function describe(selection: Selection): string {
  return `${selection.provider}/${selection.model}${selection.reasoningEffort === undefined ? '' : `@${selection.reasoningEffort}`}`
}

export const name = 'dataops-model-default'

/**
 * Mount the listener that keeps `agent-default-model` in step with top-level sessions.
 * @param ctx - this plugin's context.
 */
export function apply(ctx: Context): void {
  const host = ctx as unknown as Context & HostContext
  // A composition can carry the model service while missing the persistence pair; stating
  // that once at mount turns "the selector does not stick" into a one-line diagnosis.
  host.logger?.info(
    'dataops-model-default: mounted (agentDefaultModel=%s, settings=%s, configEditor=%s)',
    host.get('agentDefaultModel') !== undefined,
    host.get('settings') !== undefined,
    host.get('configEditor') !== undefined,
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Selection | undefined
  let lastPersisted: Selection | undefined
  let lastFailure: string | undefined

  /**
   * Write one selection through whichever persistence face the composition mounts.
   *
   * `saveSelection` is preferred: it owns the entry and serializes concurrent saves
   * against it. When it is missing or leaves the live default unchanged (a
   * composition without a configuration editor), the settings form is the second
   * accepted path to the same entry. Both end in the same profile write, so only a
   * failure to change the value is reported.
   */
  const persist = async (selection: Selection): Promise<void> => {
    const model = host.get('agentDefaultModel') as DefaultModelFace | undefined
    if (model !== undefined && sameSelection(model.currentSelection(), selection)) {
      lastPersisted = selection
      lastFailure = undefined
      return
    }
    try {
      if (model !== undefined) {
        await model.saveSelection(selection)
        if (sameSelection(model.currentSelection(), selection)) {
          lastPersisted = selection
          lastFailure = undefined
          host.logger?.info(`dataops-model-default: default model is now ${describe(selection)}`)
          return
        }
      }
      const settings = host.get('settings') as SettingsFace | undefined
      if (settings === undefined) {
        // A composition without config-editor has no durable write path; say so once
        // per distinct selection instead of on every event.
        const signature = describe(selection)
        if (signature !== lastFailure) {
          lastFailure = signature
          host.logger?.warn('dataops-model-default: no configuration editor is mounted; the selection was not saved')
        }
        return
      }
      await settings.update(NAMESPACE, configOf(selection))
      lastPersisted = selection
      lastFailure = undefined
      host.logger?.info(`dataops-model-default: default model is now ${describe(selection)}`)
    } catch (error: unknown) {
      const signature = `${describe(selection)}: ${String(error)}`
      if (signature !== lastFailure) {
        lastFailure = signature
        host.logger?.warn('dataops-model-default: the selection could not be saved as the default', error)
      }
    }
  }

  /** Run the pending write; a failed save never blocks the next one. */
  const flush = (): void => {
    timer = undefined
    const next = pending
    pending = undefined
    if (next !== undefined) void persist(next)
  }

  const onSessionEvent = (session: SessionLike, event: SessionEventLike): void => {
    if (!isTopLevelSession(session)) return
    const selection = selectionOf(event)
    if (selection === undefined) return
    if (lastPersisted !== undefined && sameSelection(lastPersisted, selection)) return
    pending = selection
    if (timer === undefined) timer = setTimeout(flush, PERSIST_DELAY_MS)
  }

  ctx.effect(() => {
    const off = host.on('session/event', onSessionEvent)
    return () => {
      off()
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      pending = undefined
    }
  }, 'dataops-model-default: follow top-level model selections')
}