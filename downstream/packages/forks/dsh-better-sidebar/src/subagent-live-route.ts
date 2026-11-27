/**
 * The live-preview route of the Subagent page ('subagents.live'): one
 * request per refresh instead of N per-child `subagents.history` calls.
 *
 * The route takes the already-resolved topology root (`rootSessionId`),
 * enumerates the whole descendant tree ONCE through the host subagent
 * runtime (`ctx.get('subagents')` / `listDescendants`), and folds EVERY child
 * session's newest process range with {@link foldProcess} — the plugin's port
 * of the main agent's merged process summary (category counts + the one
 * running call + its detail). It never touches DSH source and never reads the
 * model's `job_output` cursor.
 *
 * Folding a settled child is cheap by construction: the default fold stops at
 * the first range boundary it can report, so a child that is idle between
 * turns costs a handful of event reads (`snapshotEvents()` itself returns the
 * session's cached frozen snapshot, not a per-call copy).
 *
 * Degradation contract:
 * - `ctx.get('subagents')` missing, or a listing failure the host does not
 *   classify as an unreadable catalog → 503: the deployment cannot serve
 *   topology, and silently pretending the tree is empty would hide that.
 * - A root catalog the host reports as corrupt/in conflict is permanent for
 *   the session: retrying it every three seconds can never succeed. The route
 *   answers 200 with the ROOT's own live row and `degraded: 'catalog-unavailable'`
 *   so the page stays usable and the poller stops hammering the host.
 * - One child's events missing/corrupt → that child is still REPORTED (its
 *   `running` flag is the catalog's), just without a summary; the rest of the
 *   batch is unaffected.
 */
import type {
  Context,
  SidebarChildLiveView,
  SidebarSubagentsService,
} from './context-types.ts'
import { SIDE_LABEL_PREFIX } from './sidechat-core.ts'
import { foldProcess } from './process-activity.ts'
import { requireString, SidebarError } from './wire.ts'

/** The live-preview routes of the /sidebar JSON API. */
export interface SidebarSubagentLiveRoutes {
  /**
   * Fold one tree's subagent activity into a compact live map.
   * @param payload - `{ rootSessionId }`.
   * @returns `{ live: Record<sessionId, SidebarChildLiveView> }` over the
   *   whole descendant catalog plus the topology root. When the host refuses
   *   to reconstruct the root catalog (a corrupt/conflicting stored session),
   *   the map holds only the root and `degraded` says why the tree is absent.
   */
  live(payload: unknown): Promise<SidebarSubagentLiveResult>
}

/** One batch live-preview answer. */
export interface SidebarSubagentLiveResult {
  /** Folded live views keyed by session id (always includes the root). */
  live: Record<string, SidebarChildLiveView>
  /** Present when the host could not read the root's child catalog. */
  degraded?: 'catalog-unavailable'
}

/** Host session-query error codes for a catalog that cannot be reconstructed. */
const UNREADABLE_CATALOG_CODES = new Set([
  'SESSION_QUERY_CORRUPT_SESSION',
  'SESSION_QUERY_SOURCE_CONFLICT',
])

/** Read the string `code` a host failure carries, when it carries one. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Build the live-preview routes bound to the plugin context.
 * @param ctx - host plugin context.
 */
export function buildSubagentLiveApi(ctx: Context): SidebarSubagentLiveRoutes {
  /**
   * Roots already reported as degraded, so one broken session does not print a
   * warning on every three-second poll. Bounded like every module-level cache
   * in this plugin; clearing at the cap only costs a repeated line.
   */
  const warnedRoots = new Set<string>()

  return {
    async live(payload) {
      const rootSessionId = requireString(payload, 'rootSessionId')
      const subagents = ctx.get('subagents') as SidebarSubagentsService | undefined
      if (subagents === undefined || typeof subagents.listDescendants !== 'function') {
        throw new SidebarError(
          'subagents-unavailable',
          'the subagent service is not mounted in this deployment',
          503,
        )
      }

      const live: Record<string, SidebarChildLiveView> = {}
      /**
       * Fold one session into the map. `running` is the caller-visible activity
       * flag: the catalog's for a child, undefined for the topology ROOT (the
       * host cannot classify it, and the page already knows the answer from the
       * session list). The fold's own `live` gate is that flag when it exists,
       * and the LOG's evidence for the root.
       */
      const foldInto = (sessionId: string, running: boolean | undefined): void => {
        const view: SidebarChildLiveView = running === undefined ? {} : { running }
        try {
          const events = ctx.sessions.get(sessionId)?.snapshotEvents() ?? []
          const fold = foldProcess(events, { live: running !== false })
          if (fold.current.counts.length > 0 || fold.current.running !== undefined) {
            view.summary = fold.current
          }
          if (fold.text !== undefined) view.text = fold.text
          if (fold.lastEventTime !== undefined) view.lastEventTime = fold.lastEventTime
        } catch {
          // One session's event log is not readable: keep the row (a child's
          // running flag is the catalog's) and skip only its details.
        }
        live[sessionId] = view
      }

      let descendants
      try {
        descendants = await subagents.listDescendants(rootSessionId)
      } catch (error) {
        const code = errorCodeOf(error)
        if (code === undefined || !UNREADABLE_CATALOG_CODES.has(code)) {
          throw new SidebarError(
            'subagents-unavailable',
            `subagent catalog read failed: ${error instanceof Error ? error.message : String(error)}`,
            503,
          )
        }
        // The host cannot reconstruct this session's catalog, and no amount of
        // polling will change that. Keep the page working with the root's own
        // activity and tell the caller the tree is unavailable; the child cards
        // still come from the session's catalog projection.
        if (!warnedRoots.has(rootSessionId)) {
          if (warnedRoots.size >= 64) warnedRoots.clear()
          warnedRoots.add(rootSessionId)
          ctx.logger?.warn?.(
            'dsh-better-sidebar: subagents.live degraded for %s (%s)',
            rootSessionId,
            code,
          )
        }
        foldInto(rootSessionId, undefined)
        return { live, degraded: 'catalog-unavailable' }
      }

      foldInto(rootSessionId, undefined)
      for (const entry of descendants) {
        if (entry.kind !== 'child') continue
        // Side Chat threads ride the subagent origin but are sidebar tabs,
        // never topology — keep them out of the live map too.
        if (entry.label?.startsWith(SIDE_LABEL_PREFIX) ?? false) continue
        foldInto(entry.id, entry.activity === 'running')
      }
      return { live }
    },
  }
}
