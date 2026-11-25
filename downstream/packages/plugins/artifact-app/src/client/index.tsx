/**
 * Client half of the artifact-app plugin.
 *
 * Registers the `dataops-artifact-apps` right-sidebar tab, the cockpit HTML file
 * viewer, and the SSE bridge that lets `cockpit_open` drive the sidebar. All three
 * are optional when a profile has no Better Sidebar: the host routes and tools keep
 * working without a browser surface.
 *
 * @module @sparkelf/dsh-artifact-app/client
 */

import { useEffect } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { CockpitTab, type CockpitReferenceInput } from './CockpitTab.tsx'
import { ArtifactFileViewer, isArtifactFile } from './ArtifactFileViewer.tsx'

/** Client services this plugin reads; `slots` owns the always-mounted bridge seat. */
export const inject = ['slots']

/** Minimal composer surface used by the "添加到对话" hand-off. */
interface SessionInputLike {
  insertReference?: (ref: unknown, span: { start: number; end: number; draftRev: number }) => boolean
  state?: { getSnapshot?: () => { draft: string; draftRev: number } }
}

/** Services the reference hand-off resolves lazily, mirroring the managed resource tab. */
interface ConversationLike {
  input?: { for?: (scope: unknown) => SessionInputLike | undefined }
}

interface SessionsLike {
  scope?: (sessionId: string) => unknown | undefined
}

interface InputTriggersLike {
  registerSource?: (source: unknown) => () => void
}

/** Reference source id shared by the chip codec and the inserted reference. */
const REFERENCE_SOURCE = 'dataops-artifact-app'

/** Tab id shared by registration, the bridge and the tools. */
export const ARTIFACT_TAB_TYPE = 'dataops-artifact-apps'
/** File viewer id. */
export const ARTIFACT_VIEWER_ID = 'artifact-app:cockpit'

/** The part of Better Sidebar this plugin uses. */
interface BetterSidebarLike {
  registerTab?(descriptor: Record<string, unknown>): () => void
  registerFileViewer?(descriptor: Record<string, unknown>): () => void
  openTab?(seed: { type: string; id?: string; title?: string; meta?: unknown }, scope?: { sessionId?: string }): void
  updateTab?(tabId: string, patch: { title?: string; meta?: unknown }, sessionId?: string): void
}

interface OpenEvent {
  type: 'open_cockpit'
  cockpitId: string
  cockpitName: string | null
  mode: string
  nonce: string
  requestId: string
}

interface UpdatedEvent {
  type: 'cockpit_updated'
  cockpitId: string
  nonce: string
}

/** Invisible bridge: SSE navigation events become Better Sidebar calls. */
function OpenCockpitBridge({ service, scope }: { service: BetterSidebarLike; scope?: { sessionId?: string } }) {
  useEffect(() => {
    if (typeof EventSource !== 'function') return undefined
    const source = new EventSource('/dsh-artifact-app/open/events')
    const open = (event: MessageEvent): void => {
      let parsed: OpenEvent
      try { parsed = JSON.parse(String(event.data)) as OpenEvent } catch { return }
      if (parsed.type !== 'open_cockpit' || typeof parsed.cockpitId !== 'string') return
      const meta = { cockpitId: parsed.cockpitId, cockpitName: parsed.cockpitName, nonce: parsed.nonce, mode: parsed.mode }
      service.openTab?.({ type: ARTIFACT_TAB_TYPE, id: ARTIFACT_TAB_TYPE, title: '驾驶舱', meta }, scope)
      service.updateTab?.(ARTIFACT_TAB_TYPE, { title: '驾驶舱', meta }, scope?.sessionId)
    }
    const updated = (event: MessageEvent): void => {
      let parsed: UpdatedEvent
      try { parsed = JSON.parse(String(event.data)) as UpdatedEvent } catch { return }
      if (parsed.type !== 'cockpit_updated' || typeof parsed.cockpitId !== 'string') return
      service.updateTab?.(ARTIFACT_TAB_TYPE, {
        title: '驾驶舱',
        meta: { cockpitId: parsed.cockpitId, nonce: parsed.nonce },
      }, scope?.sessionId)
    }
    source.addEventListener('dataops-open-cockpit', open as EventListener)
    source.addEventListener('dataops-cockpit-updated', updated as EventListener)
    return () => {
      source.removeEventListener('dataops-open-cockpit', open as EventListener)
      source.removeEventListener('dataops-cockpit-updated', updated as EventListener)
      source.close()
    }
  }, [service, scope])
  return null
}

/**
 * Register the tab, the file viewer and the bridge.
 * @param ctx - DSH client context.
 */
export function apply(ctx: ClientContext): void {
  try {
  ctx.effect(() => {
    let disposeTab: (() => void) | undefined
    let disposeViewer: (() => void) | undefined
    let disposeBridge: (() => void) | undefined
    let betterSidebarService: BetterSidebarLike | undefined
    const inject = (ctx as unknown as {
      inject?: (names: readonly string[], callback: (injected: {
        betterSidebar?: BetterSidebarLike
        conversation?: ConversationLike
        sessions?: SessionsLike
        inputTriggers?: InputTriggersLike
      }) => void) => unknown
    }).inject
    inject?.(['betterSidebar', 'conversation', 'sessions', 'inputTriggers'], (injected) => {
      const service = injected.betterSidebar
      if (service?.registerTab === undefined) return
      betterSidebarService = service

      // The composer resolves this source's codec on submit and asks it for the model text.
      // Same protocol as the DataOps resource tab: chip in the draft, readable block on send.
      if (injected.inputTriggers?.registerSource !== undefined) {
        const source = {
          trigger: '@',
          name: REFERENCE_SOURCE,
          showGroupTitle: false,
          candidates: async () => [],
          codec: {
            clipboardText: (ref: string) => {
              try { return '@' + String((JSON.parse(ref) as { name?: unknown }).name ?? '驾驶舱') } catch { return '@驾驶舱' }
            },
            serialize: async (ref: string) => {
              try {
                const parsed = JSON.parse(ref) as { assetKind?: unknown; id?: unknown; name?: unknown; catalog?: unknown }
                return '引用驾驶舱：\n\n```cockpit-ref\n' + JSON.stringify({
                  kind: REFERENCE_SOURCE,
                  assetKind: parsed.assetKind === 'template' ? 'template' : 'app',
                  id: parsed.id,
                  name: parsed.name,
                  catalog: parsed.catalog ?? null,
                }, null, 2) + '\n```\n'
              } catch { return ref }
            },
          },
        }
        try { injected.inputTriggers.registerSource(source) } catch { /* HMR / duplicate source: keep the existing owner */ }
      }

      const insertArtifactReference = (item: CockpitReferenceInput, sessionId?: string): void => {
        if (sessionId === undefined) throw new Error('no active session')
        const input = injected.conversation?.input?.for?.(injected.sessions?.scope?.(sessionId))
        if (input?.insertReference === undefined || input.state?.getSnapshot === undefined) throw new Error('composer is unavailable')
        const state = input.state.getSnapshot()
        const span = { start: state.draft.length, end: state.draft.length, draftRev: state.draftRev }
        const inserted = input.insertReference({
          source: REFERENCE_SOURCE,
          ref: JSON.stringify({
            kind: REFERENCE_SOURCE,
            assetKind: item.kind,
            id: item.id,
            name: item.name,
            catalog: item.catalog ?? null,
          }),
          label: item.name,
          appearance: 'resource',
          clipboardText: '@' + item.name,
        } as never, span)
        if (!inserted) throw new Error('输入框正忙，请稍后再试')
      }

      disposeTab = service.registerTab({
        id: ARTIFACT_TAB_TYPE,
        title: '驾驶舱',
        // A component, not a fixed element: the tab strip asks for 14 and the start-guide tile
        // asks for 22, and the tile must not draw a larger glyph than its neighbours.
        icon: ({ size = 14 }: { size?: number }) => (
          <svg width={size >= 22 ? 22 : size} height={size >= 22 ? 22 : size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 18a8 8 0 1 1 16 0" />
            <path d="M12 18l4.2-5" />
            <circle cx="12" cy="18" r="1.4" />
          </svg>
        ),

        description: 'DataOps 驾驶舱资产、预览与发布',
        order: 62,
        single: true,
        component: ((props: Record<string, unknown>) => CockpitTab({
          ...(props as { tab: { meta?: unknown }; scope?: { sessionId?: string } }),
          insertArtifactReference,
        })) as never,
      })
      disposeViewer = service.registerFileViewer?.({
        id: ARTIFACT_VIEWER_ID,
        title: '驾驶舱预览',
        // Detection is the only claim. Better Sidebar 0.29 still falls through
        // to `exts.includes(ext)` after a failed `detect`, so a non-empty list
        // here would capture every `.html` in the workspace and run it through
        // the cockpit template contract — plain pages then fail with
        // TEMPLATE_CONTRACT_MISSING instead of opening in the normal preview.
        exts: [],
        priority: 60,
        fetchStrategy: 'fsRead',
        detect: (path: string, head: Uint8Array) => isArtifactFile(path, head),
        component: ((props: Record<string, unknown>) => ArtifactFileViewer(props as never)) as never,
      })
    })
    const slots = (ctx as unknown as {
      slots: {
        inject(name: string, factory: () => () => void): () => void
        register(options: Record<string, unknown>, component: (props: never) => unknown): () => void
      }
    }).slots
    disposeBridge = slots.inject('sidebar.footer.action', () => slots.register({
      name: 'sidebar.footer.action',
      id: 'artifact-app-bridge',
      order: 96,
    }, ((props: { scope?: { sessionId?: string } }) => (betterSidebarService === undefined
      ? null
      : OpenCockpitBridge({ service: betterSidebarService, scope: props?.scope }))) as never))
    return () => {
      disposeBridge?.()
      disposeBridge = undefined
      disposeViewer?.()
      disposeViewer = undefined
      disposeTab?.()
      disposeTab = undefined
    }
  }, 'artifact-app: sidebar tab, file viewer and open bridge')
  } catch (error) {
    console.error('[artifact-app] apply failed', error)
    throw error
  }
}