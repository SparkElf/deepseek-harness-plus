/**
 * Client half of the document-recognition plugin.
 *
 * Contributes one surface: a Settings section where a super administrator configures the
 * MinerU address every member's documents are recognized with. There is no sidebar entry and
 * no management page -- the feature is a skill plus this one write path, and a second
 * navigation entry would promise a page with nothing else on it.
 *
 * The namespace is its own (`settingsOcr`), so this section cannot collide with the knowledge
 * base's `settings.knowledgeBase` entry beside it.
 *
 * @module @sparkelf/dsh-ocr/client
 */

import type {} from './contract.ts'
import { OcrSettingsSection } from './SettingsSection.tsx'
import type { OcrSettingsInjected } from './SettingsSection.tsx'
import type { OcrClientContext } from './context.ts'
import { en, zh } from './locales.ts'
import { installConditionalSection, type VisibilityWindow } from './sectionVisibility.ts'

/** Locale namespace this plugin owns. */
const NS = 'settingsOcr'

/** Settings entry id; also the `id` the section registers under. */
const SECTION_ID = 'ocr'

/**
 * Rank places this section beside the other DataOps capabilities.
 *
 * The knowledge base uses 35 and Mobile Bridge uses 40, so this one follows them. The value
 * orders the Settings navigation, not a priority.
 */
const SECTION_ORDER = 36

/** Services the browser half needs to contribute a Settings section. */
export const inject = ['slots', 'locale']

/**
 * Register the document-recognition Settings section.
 * @param ctx - the DSH client context carrying the slot and locale registries.
 */
export function apply(ctx: OcrClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ocr: dictionaries')

  ctx.slots.inject('settings.section', () => {
    if (typeof window === 'undefined') return () => {}
    return installConditionalSection({
      window: window as unknown as VisibilityWindow,
      register: () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: SECTION_ORDER,
        label: () => ctx.locale.bind(NS)('nav'),
        locale: NS,
        inject: (): OcrSettingsInjected => ({ t: ctx.locale.bind(NS) }),
      }, OcrSettingsSection),
      // The account bridge publishes the role into `__DATAOPS_USER__` and writes it onto
      // <html data-dataops-account-name>. The event is the contract; the observer is the
      // same-tab fallback for a portal bundle that predates the event.
      observe: (sync) => {
        if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => {}
        const observer = new MutationObserver(() => { sync() })
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-dataops-account-name'] })
        return () => { observer.disconnect() }
      },
      onError: (error) => { console.error('dsh-ocr: settings section registration rejected', error) },
    })
  })
}
