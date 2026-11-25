/**
 * The Client services this plugin consumes, declared structurally.
 *
 * Restated rather than imported from each owning package: the browser bundle may only reach
 * the loader's platform modules, and a type-only import of a package that ships no
 * `./client` entry would fail to resolve. The shape below is the part of the slot and locale
 * registries this plugin actually calls, which is the contract it has to satisfy.
 *
 * @module @sparkelf/dsh-ocr/client/context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LocaleDictOf, LocaleNamespaceMap, SlotCore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** The two slot operations this plugin uses. */
interface ClientSlots {
  /** Register one occupant of a declared slot. */
  register: SlotCore['register']
  /** Contribute to one named slot, with a disposer factory. */
  inject(name: 'settings.section', factory: () => () => void): void
}

/** The locale operations this plugin uses. */
interface ClientLocale {
  /** Register one namespace's dictionaries; returns its disposer. */
  register<N extends keyof LocaleNamespaceMap & string>(
    namespace: N,
    dictionaries: { zh: LocaleDictOf<N>; en: LocaleDictOf<N> },
  ): () => void
  /** Bind one namespace's resolver. */
  bind<N extends keyof LocaleNamespaceMap & string>(namespace: N): TranslateNS<N>
}

/** Client Cordis context services consumed by the document-recognition plugin. */
export type OcrClientContext = Context & {
  slots: ClientSlots
  locale: ClientLocale
}
