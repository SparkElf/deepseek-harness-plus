import { ResourceTabIcon } from './ResourceTabIcon.tsx'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the skill center's slot declaration so this plugin can contribute to it.
import type {} from '@sparkelf/dsh-client-ui-skill-center/client'
import { ManagedDataOpsSection } from './ManagedDataOpsSection.tsx'
import { SkillPlazaSection } from './SkillPlazaSection.tsx'
import { installWanxiangBranding } from './install-branding.tsx'
import { wanxiangBrandPreference } from './brand-store.ts'
import { ReloginPrompt, type ReloginPromptProps } from './ReloginPrompt.tsx'
import { PermissionCenterSection } from './PermissionCenterSection.tsx'
import { PermissionCenterIcon } from './PermissionCenterIcon.tsx'
import { WorkspaceUpgradePrompt } from './WorkspaceUpgradePrompt.tsx'
import { BrowserVersionPrompt } from './BrowserVersionPrompt.tsx'
import { WorkflowPlazaBell } from './NotificationBell.tsx'
import { DataOpsResourcesTab } from './DataOpsResourcesTab.tsx'
import { OpenResourceBridge, RESOURCE_TAB_TYPE, type ResourceTabService } from './OpenResourceBridge.tsx'
import { canSeeManagedSettings, subscribeManagedSettingsVisibility } from './settings-gate.ts'
import { REVIEW_CONTEXT_PATH, reviewDemoMode } from './review-client.ts'
import type { ManagedDataOpsSectionInjected } from './ManagedDataOpsSection.tsx'
import { en, zh, type ManagedDataOpsKey } from './locales.ts'

/** Minimal public composer surface used by the resource-reference hand-off. */
type SessionInputLike = {
  insertReference?: (ref: unknown, span: { start: number; end: number; draftRev: number }) => boolean
  state?: { getSnapshot?: () => { draft: string; draftRev: number } }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Header actions declared by the knowledge-base workflow plaza. */
    'workflow-plaza.actions': {
      kind: 'single'
      scope: 'root'
      owner: Record<string, never>
      hookContext: unknown
    }
  }

  interface LocaleNamespaceMap {
    'settings.dataops-managed': ManagedDataOpsKey
  }
}

const NS = 'settings.dataops-managed'
const AUTH_UPDATED_MESSAGE = 'dataops-auth-updated'
const MANAGED_AUTH_PATH = 'integrations/dataops/managed-auth'

/** Sidebar entry and main page id for the permission centre. */
const PERMISSION_PANEL_ID = 'dataops-permissions'

/** Required client services for the managed DataOps Settings section and the resource tab bridge. */
export const inject = ['slots', 'locale', 'conversation', 'sessions']

/**
 * Bind the four strings the sign-in prompt needs.
 *
 * Narrowed to exactly those keys rather than reusing the settings-section resolver: the prompt
 * asks its own small copy, and a wider type would let a typo pass as a valid key.
 *
 * @param ctx - client context carrying the registered namespace.
 * @returns a resolver for the prompt's own keys.
 */
const bindReloginCopy = (ctx: ClientContext): ReloginPromptProps['t'] => {
  const translate = ctx.locale.bind(NS) as (key: string) => string
  return (key) => translate(key)
}

/**
 * Register the managed DataOps surfaces and the sign-in prompt.
 *
 * The prompt rides a sidebar seat because the client needs *some* always-mounted surface for a
 * dialog that is about the whole workspace rather than one panel. The seat is a container: the
 * dialog itself portals to `document.body`, so this contributes no visible element to the
 * sidebar at rest and cannot disturb the regions that already live there.
 *
 * @param ctx - DSH client context with locale, slots and the sidebar foot.
 */
/**
 * 自动配对：DSH 页面本身就是用户已经打开的网页，不需要再让用户去另一个「桥接页面」。
 *
 * 页面加载后探测本机 Companion（127.0.0.1:8932）。如果它已启动但未配对，向 Host 要一个
 * 一次性配对码，直接 POST 给 Companion；Companion 自己建立出站隧道，插件随后自动建会话。
 * 整个过程用户无感；失败（未安装/未启动）就静默重试，不弹窗、不打断对话。
 */
const autoPairLocalBridge = async (): Promise<void> => {
  try {
    const probe = new AbortController()
    const timer = window.setTimeout(() => probe.abort(), 1_500)
    const status = await fetch('http://127.0.0.1:8932/status', { signal: probe.signal, cache: 'no-store' })
    window.clearTimeout(timer)
    if (!status.ok) return
    const snapshot = await status.json() as { paired?: unknown }
    if (snapshot.paired === true) return
    const created = await fetch('/integrations/dataops/browser-bridge/auto-pair', { method: 'POST' })
    if (!created.ok) return
    const payload = await created.json() as { code?: unknown; serverUrl?: unknown }
    if (typeof payload.code !== 'string' || typeof payload.serverUrl !== 'string') return
    await fetch('http://127.0.0.1:8932/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: payload.code, serverUrl: payload.serverUrl }),
    })
  } catch {
    // Companion 未安装/未启动/跨域被拦截：静默，不影响对话。
  }
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS as never, { zh, en }), 'dataops-managed: settings copy')
  installWanxiangBranding(ctx)
  ctx.effect(() => {
    let disposed = false
    const run = (): void => { if (!disposed) void autoPairLocalBridge() }
    run()
    const timer = window.setInterval(run, 30_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, 'dataops-managed: browser bridge auto pair')

  /**
   * The DSH logo returns to the portal page the reader entered from.
   *
   * The portal records `dataops.ai.returnTo` in sessionStorage before mounting this frame;
   * its shell owns the router, so this half only asks it to navigate. The menu label is
   * DSH-owned, hence the visible-text match rather than a stable id.
   */
  ctx.effect(() => {
    if (window.parent === window) return () => {}
    const onLogoClick = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      // Match the brand button itself, never an ancestor that merely contains it.
      // The sidebar wraps the logo, the new-session button and every panel row in the
      // same container; matching `textContent` on that container made "new session"
      // and panel switches post `return-to` and replaced the whole workbench with the
      // portal home. The brand row is the only interactive element with a brand/logo
      // class that also carries the product name.
      const interactive = target.closest('button, a')
      if (interactive === null) return
      const className = typeof interactive.className === 'string' ? interactive.className : ''
      if (!/brand|logo/i.test(className)) return
      const text = (interactive.textContent ?? '').trim()
      // The portal may rename the platform, so match the live name before the legacy fallback.
      const brandName = wanxiangBrandPreference.getSnapshot().name
      if (!text.includes(brandName) && !/万相AI中台|Wanxiang AI/i.test(text)) return
      event.preventDefault()
      event.stopPropagation()
      window.parent.postMessage({ type: 'dataops:return-to', version: 1 }, '*')
    }
    document.addEventListener('click', onLogoClick, true)
    return () => document.removeEventListener('click', onLogoClick, true)
  }, 'dataops-managed: return-to logo')

  const t = ctx.locale.bind(NS) as ManagedDataOpsSectionInjected['t']

  /**
   * Register the settings section only for the two administrator role labels.
   *
   * The identity record arrives after the iframe loads and can change when the portal account is
   * switched, so the registration is reconciled whenever the shared account store publishes. An
   * ordinary user's profile therefore has no section, no configuration form, and no publish
   * control at all — not a hidden one.
   */
  ctx.effect(() => {
    let disposeSection: (() => void) | undefined
    const reconcile = (): void => {
      const allowed = canSeeManagedSettings()
      if (allowed && disposeSection === undefined) {
        disposeSection = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dataops',
          order: 25,
          label: () => t('nav'),
          inject: () => ({ t }),
        }, ManagedDataOpsSection))
      } else if (!allowed && disposeSection !== undefined) {
        disposeSection()
        disposeSection = undefined
      }
    }
    reconcile()
    const unsubscribe = subscribeManagedSettingsVisibility(reconcile)
    return () => {
      unsubscribe()
      disposeSection?.()
      disposeSection = undefined
    }
  }, 'dataops-managed: settings section role gate')

  /**
   * The re-authentication prompt, mounted where it is always alive.
   *
   * A dialog needs a component that stays mounted whether or not the operator has the settings
   * panel open, and the sidebar foot is the one seat this plugin already owns. The component
   * renders nothing until DataOps reports the session has ended, so at rest it adds no element.
   */
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dataops-relogin',
    order: 90,
    inject: () => ({ t: bindReloginCopy(ctx) }),
  }, ReloginPrompt))
  /**
   * The workspace image upgrade notice. It lives in the shell overlay so it can sit
   * above the page without taking a sidebar or conversation seat; the component renders
   * nothing until DataOps reports a newer image.
   */
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dataops-workspace-upgrade',
    order: 20,
    inject: () => ({ t }),
  }, WorkspaceUpgradePrompt as never))
  /** Browser-version notice: same overlay seat, but a separate capability and copy. */
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dataops-browser-version',
    order: 21,
    inject: () => ({ t }),
  }, BrowserVersionPrompt as never))

  /**
   * The permission centre, a sidebar entry plus the page it opens.
   *
   * The entry's glyph hides itself for an ordinary user; the page and every backend endpoint
   * re-check the caller, so hiding is navigation, not authorization.
   */
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PERMISSION_PANEL_ID as never,
  }, (() => PermissionCenterSection({ t })) as never)), 'dataops-managed: permission centre page')

  ctx.effect(() => {
    let disposeEntry: (() => void) | undefined
    let live = true
    const allowed = async (): Promise<boolean> => {
      if (typeof window !== 'undefined' && reviewDemoMode()) return true
      // The two managed-settings roles are already known from the launcher label; a department
      // administrator is only known from the review context, so ask the Host in that case.
      if (canSeeManagedSettings()) return true
      try {
        const response = await fetch(REVIEW_CONTEXT_PATH)
        if (!response.ok) return false
        const body = await response.json() as { primaryRole?: string; review?: { canReview?: boolean } }
        return body.primaryRole === 'DEPT_ADMIN' || body.review?.canReview === true
      } catch {
        return false
      }
    }
    const sync = async (): Promise<void> => {
      const next = await allowed()
      if (!live) return
      if (next && disposeEntry === undefined) {
        disposeEntry = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PERMISSION_PANEL_ID,
          order: 20,
          label: () => t('permNav'),
          locale: NS as never,
        }, PermissionCenterIcon as never))
      } else if (!next && disposeEntry !== undefined) {
        disposeEntry()
        disposeEntry = undefined
      }
    }
    void sync()
    const off = subscribeManagedSettingsVisibility(() => { void sync() })
    return () => {
      live = false
      off()
      disposeEntry?.()
      disposeEntry = undefined
    }
  }, 'dataops-managed: permission centre entry gate')

  /**
   * The skill plaza, contributed to the skill center page.
   *
   * The skill center declares the slot and renders whatever it holds; a profile without this
   * plugin leaves it empty, which is what keeps the plaza out of a deployment that never
   * installed DataOps.
   */
  ctx.slots.inject('skill-center.section', () => ctx.slots.register({
    name: 'skill-center.section',
    id: 'dataops-plaza',
    order: 10,
    inject: () => ({ t }),
  }, SkillPlazaSection))

  /**
   * The workflow plaza's header seat, declared by the knowledge-base plugin. It renders a slot
   * rather than importing this plugin; the bell therefore joins only when both are installed.
   */
  ctx.slots.inject('workflow-plaza.actions' as never, () => (ctx.slots.register as (options: unknown, component: unknown) => () => void)({
    name: 'workflow-plaza.actions',
  }, WorkflowPlazaBell))

  /**
   * The custom DataOps resource tab and the host→client opening bridge.
   *
   * Both are optional on the Better Sidebar service: a profile without it keeps the rest of
   * the managed surfaces and simply has no sidebar resource page. The registration waits for
   * the service instead of sampling it once, because plugin load order is not ours to choose.
   */
  ctx.effect(() => {
    let disposeTab: (() => void) | undefined
    let disposeBridge: (() => void) | undefined
    const inject = (ctx as unknown as {
      inject?: (names: readonly string[], callback: (injected: { betterSidebar?: ResourceTabService }) => void) => unknown
    }).inject
    inject?.(['betterSidebar', 'conversation', 'sessions', 'inputTriggers'], (injected) => {
      const service = injected.betterSidebar as (ResourceTabService & {
        registerTab?: (descriptor: Record<string, unknown>) => () => void
      }) | undefined
      if (service?.registerTab === undefined) return
      const conversation = (injected as {
        conversation?: {
          send?: (text: string) => Promise<void>
          input?: { for?: (actx: unknown) => SessionInputLike | undefined }
        }
      }).conversation
      const sessions = (injected as {
        sessions?: { scope?: (id: string) => unknown | undefined }
      }).sessions
      const inputTriggers = (injected as {
        inputTriggers?: { registerSource?: (source: unknown) => () => void }
      }).inputTriggers
      // The chip owner: the composer resolves this source's codec on submit and asks it
      // for the model text. The ref carries the resource identity so a later submit can
      // still serialize after the tab has moved on.
      if (inputTriggers?.registerSource !== undefined) {
        const source = {
          trigger: '@',
          name: 'dataops-resource',
          showGroupTitle: false,
          candidates: async () => [],
          codec: {
            clipboardText: (ref: string) => {
              try { return '@' + String((JSON.parse(ref) as { name?: unknown }).name ?? '资源') } catch { return '@资源' }
            },
            serialize: async (ref: string) => {
              try {
                const parsed = JSON.parse(ref) as { kind?: unknown; resourceId?: unknown; name?: unknown; table?: unknown }
                return '引用数据资源：\n\n```resource-ref\n' + JSON.stringify({
                  kind: 'dataops-resource',
                  resourceId: parsed.resourceId,
                  name: parsed.name,
                  table: parsed.table ?? null,
                }, null, 2) + '\n```\n'
              } catch { return ref }
            },
          },
        }
        try { inputTriggers.registerSource(source) } catch { /* HMR / duplicate source: keep the existing owner */ }
      }
      const insertResourceReference = (
        resource: { id?: unknown; name?: unknown; table?: unknown },
        reference: Record<string, unknown>,
        sessionId?: string,
      ): void => {
        if (!sessionId) throw new Error('no active session')
        const scoped = sessions?.scope?.(sessionId)
        const input = conversation?.input?.for?.(scoped)
        if (!input?.insertReference || !input.state?.getSnapshot) throw new Error('composer is unavailable')
        const state = input.state.getSnapshot()
        const span = { start: state.draft.length, end: state.draft.length, draftRev: state.draftRev }
        const name = String(resource.name ?? reference.name ?? '资源')
        const payload = {
          kind: 'dataops-resource',
          resourceId: resource.id ?? reference.resourceId,
          name,
          table: resource.table ?? reference.table ?? null,
        }
        const inserted = input.insertReference({
          source: 'dataops-resource',
          ref: JSON.stringify(payload),
          label: name,
          appearance: 'resource',
          clipboardText: '@' + name,
        } as never, span)
        if (!inserted) throw new Error('输入框正忙，请稍后再试')
      }
      disposeTab = service.registerTab({
        id: RESOURCE_TAB_TYPE,
        title: '数据资源',
        icon: ResourceTabIcon,
        description: 'DataOps 全量资源、授权与操作记录',
        order: 60,
        single: true,
        component: ((props: Record<string, unknown>) => DataOpsResourcesTab({
          ...(props as { tab: { meta?: unknown }; scope?: { sessionId?: string } }),
          insertResourceReference,
        })) as never,
      })
      disposeBridge = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dataops-resource-bridge',
        order: 95,
      }, ((props: { scope?: { sessionId?: string } }) => OpenResourceBridge({
        service,
        scope: props?.scope,
      })) as never))
    })
    return () => {
      disposeBridge?.()
      disposeBridge = undefined
      disposeTab?.()
      disposeTab = undefined
    }
  }, 'dataops-managed: resource tab and open bridge')

  const synchronizeJwt = async (): Promise<void> => {
    const response = await fetch(new URL(MANAGED_AUTH_PATH, window.location.origin), {
      method: 'POST',
      credentials: 'same-origin',
    })
    if (!response.ok) throw new Error(`DataOps managed JWT synchronization failed with HTTP ${String(response.status)}`)
  }
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (event.source !== window.parent
      || (event.data as { type?: unknown } | null)?.type !== AUTH_UPDATED_MESSAGE) return
    void synchronizeJwt().catch(error => console.error('dataops-managed.jwt_sync_failed', error))
  }
  ctx.effect(() => {
    window.addEventListener('message', onMessage)
    void synchronizeJwt().catch(error => console.error('dataops-managed.jwt_sync_failed', error))
    return () => window.removeEventListener('message', onMessage)
  }, 'dataops-managed: JWT synchronization')
}
