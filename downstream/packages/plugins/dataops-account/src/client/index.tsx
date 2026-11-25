/**
 * DataOps account client plugin.
 *
 * Two responsibilities, both at official extension points:
 * - It shadows the `settings.launcher` cell at a negative priority, which is
 *   the slot registry's own shadowing mechanism. The replacement renders the
 *   DataOps avatar and nickname and offers only the actions that still mean
 *   something here: Settings and Feedback. The DeepSeek sign-in row disappears
 *   with the official component, not by deleting DOM after the fact.
 * - It listens for the presentation-only identity the DataOps portal posts into
 *   the workbench iframe and republishes it as a small external store plus
 *   `data-*` attributes, so a reload can paint the last known identity before
 *   the portal answers again.
 *
 * @module @sparkelf/dsh-dataops-account/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import './contract.ts'
import { DataOpsAccountLauncher, type DataOpsAccountInjected } from './DataOpsAccountLauncher.tsx'
import { installSignedOutMenuGuard } from './dom-guard.ts'
import { installFeedbackBridge } from './feedback.ts'
import { installIdentityBridge } from './identity.ts'
import { en, zh, type AccountKey } from './locales.ts'

const NS = 'dataops.account'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dataops.account': AccountKey
  }
}

/**
 * Below every ordinary registration: the slot registry renders the lowest live
 * priority of a single cell, and the official launcher sits at the default 0.
 * A named constant keeps a repeated evaluation (reload, HMR) from trying to
 * register the same cell twice when only this value identifies our claim.
 */
const SHADOW_PRIORITY = -100

export const inject = ['slots', 'locale']

/**
 * Register the copy, the identity bridge, and the launcher override.
 * @param ctx - DSH client context with the slot and locale registries.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dataops-account: copy')
  const t = ctx.locale.bind(NS) as (key: AccountKey) => string

  ctx.effect(() => installIdentityBridge(), 'dataops-account: identity bridge')
  ctx.effect(() => installFeedbackBridge(), 'dataops-account: feedback bridge')
  ctx.effect(() => installSignedOutMenuGuard(), 'dataops-account: signed-out menu guard')

  ctx.slots.inject('settings.launcher', () => {
    // Registering a second entry in the same cell at the same priority throws,
    // which would take the whole contribution down. A previous evaluation of
    // this bundle (reload, HMR) can leave its entry behind, so occupancy is
    // read from the ledger before claiming.
    const alreadyClaimed = ctx.slots
      .entries('settings.launcher')
      .some(entry => (entry.options.priority ?? 0) === SHADOW_PRIORITY)
    if (alreadyClaimed) return () => {}

    let dispose: (() => void) | undefined
    try {
      dispose = ctx.slots.register({
        name: 'settings.launcher',
        priority: SHADOW_PRIORITY,
        inject: (): DataOpsAccountInjected => ({ t }),
      }, DataOpsAccountLauncher)
    } catch (error) {
      // Losing the cell must not take the rest of the plugin down: the guard
      // still removes the unusable sign-in row from whatever rendered.
      console.error('dataops-account: settings.launcher registration rejected', error)
    }
    return () => { dispose?.() }
  })
}