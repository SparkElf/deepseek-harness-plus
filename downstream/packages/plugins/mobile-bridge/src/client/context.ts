/** Minimal public Client services used by the external plugin. */

import type { Context } from '@deepseek-ai/cordis'
import type { LocaleDictOf, LocaleNamespaceMap, SlotCore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

interface ClientSlots {
  register: SlotCore['register']
  inject(name: 'settings.section' | 'shell.overlay', factory: () => () => void): void
}

interface ClientLocale {
  register<N extends keyof LocaleNamespaceMap & string>(namespace: N, dictionaries: { zh: LocaleDictOf<N>; en: LocaleDictOf<N> }): () => void
  bind<N extends keyof LocaleNamespaceMap & string>(namespace: N): TranslateNS<N>
}

/** Client Cordis context services consumed by Mobile Bridge. */
export type MobileBridgeClientContext = Context & {
  slots: ClientSlots
  locale: ClientLocale
}
