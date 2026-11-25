import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { wanxiangBrandPreference } from './brand-store.ts'
import {
  WanxiangHeroMark,
  WanxiangMark,
  WanxiangSidebarName,
} from './WanxiangBrand.tsx'

const BRAND_TITLE = '万相AI中台 Harness'
const SLOT_PRIORITY = -100
const FAVICON_ID = 'dataops-wanxiang-favicon'
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 54 58"><style>:root{color:#1b1b1d}@media(prefers-color-scheme:dark){:root{color:#f7f7f8}}</style><g transform="translate(15 0)" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 0 24 7 12 14 0 7Z" fill="none"/><path d="M0 7 12 14v16L0 23Z" fill="currentColor"/><path d="M12 14 24 7v16L12 30Z" fill="currentColor" fill-opacity=".18"/></g><g transform="translate(0 16)" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 0 24 7 12 14 0 7Z" fill="none"/><path d="M0 7 12 14v16L0 23Z" fill="currentColor"/><path d="M12 14 24 7v16L12 30Z" fill="currentColor" fill-opacity=".18"/></g><g transform="translate(30 16)" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 0 24 7 12 14 0 7Z" fill="none"/><path d="M0 7 12 14v16L0 23Z" fill="currentColor"/><path d="M12 14 24 7v16L12 30Z" fill="currentColor" fill-opacity=".18"/></g><g transform="translate(15 27)" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 0 24 7 12 14 0 7Z" fill="none"/><path d="M0 7 12 14v16L0 23Z" fill="currentColor"/><path d="M12 14 24 7v16L12 30Z" fill="currentColor" fill-opacity=".18"/></g></svg>`


function registerWanxiangSlots(ctx: ClientContext): () => void {
  return ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({
          name: 'sidebar.brand.mark',
          priority: SLOT_PRIORITY,
          registrant: 'dataops-managed',
        }, WanxiangMark)
        yield ctx.slots.register({
          name: 'sidebar.brand.name',
          priority: SLOT_PRIORITY,
          registrant: 'dataops-managed',
        }, WanxiangSidebarName)
        yield ctx.slots.register({
          name: 'conversation.hero.brand.mark',
          priority: SLOT_PRIORITY,
          registrant: 'dataops-managed',
        }, WanxiangHeroMark)
      })))
}

function installFavicon(): HTMLLinkElement {
  const existing = document.getElementById(FAVICON_ID)
  if (existing instanceof HTMLLinkElement) return existing
  const link = document.createElement('link')
  link.id = FAVICON_ID
  link.rel = 'icon'
  link.type = 'image/svg+xml'
  link.href = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`
  document.head.append(link)
  return link
}

/** Keep shell slots, browser title, and favicon on the same persisted preference. */
export function installWanxiangBranding(ctx: ClientContext): void {
  const originalTitle = document.title
  let disposeSlots: (() => void) | undefined
  let favicon: HTMLLinkElement | undefined
  let titleObserver: MutationObserver | undefined

  const stopTitleObserver = (): void => {
    titleObserver?.disconnect()
    titleObserver = undefined
  }
  const keepBrandTitle = (): void => {
    if (document.title !== BRAND_TITLE) document.title = BRAND_TITLE
    if (titleObserver !== undefined) return
    titleObserver = new MutationObserver(() => {
      if (wanxiangBrandPreference.getSnapshot().enabled && document.title !== BRAND_TITLE) {
        document.title = BRAND_TITLE
      }
    })
    titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true })
  }

  const synchronize = (): void => {
    const enabled = wanxiangBrandPreference.getSnapshot().enabled
    if (enabled) {
      disposeSlots ??= registerWanxiangSlots(ctx)
      favicon ??= installFavicon()
      keepBrandTitle()
      document.documentElement.dataset.dataopsBrand = 'wanxiang'
      return
    }
    disposeSlots?.()
    disposeSlots = undefined
    favicon?.remove()
    favicon = undefined
    stopTitleObserver()
    document.title = originalTitle
    delete document.documentElement.dataset.dataopsBrand
  }

  ctx.effect(() => {
    synchronize()
    const unsubscribe = wanxiangBrandPreference.subscribe(synchronize)
    return () => {
      unsubscribe()
      disposeSlots?.()
      favicon?.remove()
      stopTitleObserver()
      document.title = originalTitle
      delete document.documentElement.dataset.dataopsBrand
    }
  }, 'dataops-managed: Wanxiang shell branding')
}
