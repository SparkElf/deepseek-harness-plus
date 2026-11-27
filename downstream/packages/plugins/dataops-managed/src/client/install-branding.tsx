import { useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { fetchWanxiangBranding } from './branding-client.ts'
import {
  setWanxiangBranding,
  wanxiangBrandPreference,
  type WanxiangBranding,
} from './brand-store.ts'
import {
  WanxiangHeroMark,
  WanxiangMark,
  WanxiangSidebarName,
  type MarkProps,
} from './WanxiangBrand.tsx'

const SLOT_PRIORITY = -100
const FAVICON_ID = 'dataops-wanxiang-favicon'
const HARNESS_SUFFIX = ' Harness'
/** Poll interval; the Host caches for ten seconds, so a save lands without a page refresh. */
const BRAND_REFRESH_INTERVAL_MS = 10_000
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 54 58"><style>:root{color:#1b1b1d}@media(prefers-color-scheme:dark){:root{color:#f7f7f8}}</style><g transform="translate(15 0)" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 0 24 7 12 14 0 7Z" fill="none"/><path d="M0 7 12 14v16L0 23Z" fill="currentColor"/><path d="M12 14 24 7v16L12 30Z" fill="currentColor" fill-opacity=".18"/></g><g transform="translate(0 16)" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 0 24 7 12 14 0 7Z" fill="none"/><path d="M0 7 12 14v16L0 23Z" fill="currentColor"/><path d="M12 14 24 7v16L12 30Z" fill="currentColor" fill-opacity=".18"/></g><g transform="translate(30 16)" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 0 24 7 12 14 0 7Z" fill="none"/><path d="M0 7 12 14v16L0 23Z" fill="currentColor"/><path d="M12 14 24 7v16L12 30Z" fill="currentColor" fill-opacity=".18"/></g><g transform="translate(15 27)" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 0 24 7 12 14 0 7Z" fill="none"/><path d="M0 7 12 14v16L0 23Z" fill="currentColor"/><path d="M12 14 24 7v16L12 30Z" fill="currentColor" fill-opacity=".18"/></g></svg>`

/**
 * Browser title for a platform name.
 * @param name - Platform name currently in effect.
 * @returns The wordmark name followed by the fixed Harness suffix.
 */
export function brandDocumentTitle(name: string): string {
  return `${name}${HARNESS_SUFFIX}`
}

/**
 * Read the live brand inside a rendered slot.
 *
 * The slot seat is registered once; this subscription is what makes a fresh read from the Host
 * replace the wordmark and mark in place instead of waiting for a page reload.
 * @returns The current enabled flag and branding.
 */
function useBranding(): WanxiangBranding {
  return useSyncExternalStore(
    wanxiangBrandPreference.subscribe,
    wanxiangBrandPreference.getSnapshot,
    wanxiangBrandPreference.getSnapshot,
  )
}

/** Sidebar mark slot backed by the live portal brand. */
function BrandMarkSlot(props: MarkProps) {
  const { logo } = useBranding()
  return <WanxiangMark {...props} logo={logo} />
}

/** Welcome-page mark slot backed by the live portal brand. */
function BrandHeroSlot(props: MarkProps) {
  const { logo } = useBranding()
  return <WanxiangHeroMark {...props} logo={logo} />
}

/** Sidebar wordmark slot backed by the live portal brand. */
function BrandSidebarNameSlot() {
  const { name } = useBranding()
  return <WanxiangSidebarName name={name} />
}

function registerWanxiangSlots(ctx: ClientContext): () => void {
  return ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({
          name: 'sidebar.brand.mark',
          priority: SLOT_PRIORITY,
          registrant: 'dataops-managed',
        }, BrandMarkSlot)
        yield ctx.slots.register({
          name: 'sidebar.brand.name',
          priority: SLOT_PRIORITY,
          registrant: 'dataops-managed',
        }, BrandSidebarNameSlot)
        yield ctx.slots.register({
          name: 'conversation.hero.brand.mark',
          priority: SLOT_PRIORITY,
          registrant: 'dataops-managed',
        }, BrandHeroSlot)
      })))
}

function installFavicon(): HTMLLinkElement {
  const existing = document.getElementById(FAVICON_ID)
  if (existing instanceof HTMLLinkElement) return existing
  const link = document.createElement('link')
  link.id = FAVICON_ID
  link.rel = 'icon'
  document.head.append(link)
  return link
}

/**
 * MIME type for a custom logo, used by the favicon link.
 * @param logo - Data URL or absolute path.
 * @returns The declared type, or an empty string when the extension is unknown.
 */
function logoMimeType(logo: string): string {
  const inline = /^data:(image\/[a-z0-9.+-]+);/iu.exec(logo)
  if (inline?.[1] !== undefined) return inline[1].toLowerCase()
  const path = logo.split(/[?#]/u)[0] ?? ''
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (extension) {
    case 'svg': return 'image/svg+xml'
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    default: return ''
  }
}

/**
 * Point the favicon at the portal logo, falling back to the inline cube mark.
 * @param link - The workspace favicon link.
 * @param logo - Current custom logo, or an empty string.
 */
function applyFavicon(link: HTMLLinkElement, logo: string): void {
  if (logo === '') {
    link.type = 'image/svg+xml'
    link.href = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`
    return
  }
  link.href = logo
  const type = logoMimeType(logo)
  if (type === '') link.removeAttribute('type')
  else link.type = type
}

/** Keep shell slots, browser title, and favicon on the same live brand and persisted preference. */
export function installWanxiangBranding(ctx: ClientContext): void {
  const originalTitle = document.title
  let disposeSlots: (() => void) | undefined
  let favicon: HTMLLinkElement | undefined
  let titleObserver: MutationObserver | undefined
  /** Undefined before the first pass; guards the disabled cleanup from repeating on each poll. */
  let applied: boolean | undefined

  const stopTitleObserver = (): void => {
    titleObserver?.disconnect()
    titleObserver = undefined
  }
  const keepBrandTitle = (): void => {
    const title = brandDocumentTitle(wanxiangBrandPreference.getSnapshot().name)
    if (document.title !== title) document.title = title
    if (titleObserver !== undefined) return
    titleObserver = new MutationObserver(() => {
      if (!wanxiangBrandPreference.getSnapshot().enabled) return
      const next = brandDocumentTitle(wanxiangBrandPreference.getSnapshot().name)
      if (document.title !== next) document.title = next
    })
    titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true })
  }

  const synchronize = (): void => {
    const branding = wanxiangBrandPreference.getSnapshot()
    if (branding.enabled) {
      applied = true
      disposeSlots ??= registerWanxiangSlots(ctx)
      favicon ??= installFavicon()
      applyFavicon(favicon, branding.logo)
      keepBrandTitle()
      document.documentElement.dataset.dataopsBrand = 'wanxiang'
      return
    }
    // A branding poll must not keep overwriting a title the shell writes while the toggle is off.
    if (applied === false) return
    applied = false
    disposeSlots?.()
    disposeSlots = undefined
    favicon?.remove()
    favicon = undefined
    stopTitleObserver()
    document.title = originalTitle
    delete document.documentElement.dataset.dataopsBrand
  }

  /**
   * Read the Host once at startup and again on an interval or when the page becomes visible.
   * A failed read leaves the current brand untouched; the next tick retries.
   */
  const startBrandingRefresh = (): (() => void) => {
    let disposed = false
    let refreshing = false
    const controller = new AbortController()
    const refresh = async (): Promise<void> => {
      if (disposed || refreshing) return
      refreshing = true
      try {
        const branding = await fetchWanxiangBranding({ signal: controller.signal })
        if (!disposed && branding !== null) setWanxiangBranding(branding)
      } finally {
        refreshing = false
      }
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, BRAND_REFRESH_INTERVAL_MS)
    window.addEventListener('focus', onVisibility)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      controller.abort()
      window.clearInterval(timer)
      window.removeEventListener('focus', onVisibility)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }

  ctx.effect(() => {
    synchronize()
    const unsubscribe = wanxiangBrandPreference.subscribe(synchronize)
    const stopRefresh = startBrandingRefresh()
    return () => {
      stopRefresh()
      unsubscribe()
      disposeSlots?.()
      favicon?.remove()
      stopTitleObserver()
      document.title = originalTitle
      delete document.documentElement.dataset.dataopsBrand
    }
  }, 'dataops-managed: Wanxiang shell branding')
}
