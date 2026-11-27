/**
 * Who may see the document-recognition Settings section.
 *
 * The section configures one deployment-wide address and offers distribution writes, so it
 * belongs to the roles that administer the deployment. Every other member still USES the
 * shared address through the skill; they simply have no settings entry to change it.
 *
 * Registration is conditional rather than a component that renders null: an unauthorized
 * reader must not find a「文档识别」row in Settings at all. The role can change without a
 * reload (the portal re-posts the identity), so the decision is re-evaluated whenever the
 * account bridge says the user changed.
 *
 * @module @sparkelf/dsh-ocr/client/section-owner
 */

/** The event the DataOps account bridge dispatches after the identity changes. */
export const ACCOUNT_CHANGED_EVENT = 'dataops-account:changed'

/** Role names that may configure the shared MinerU address. Exact match, by design. */
export const OCR_SETTINGS_ROLES: readonly string[] = ['超级管理员', '管理员']

/**
 * Whether one DataOps role name may open the section.
 *
 * Exact equality: a role called「管理员助理」or「超级管理员（试用）」is a different role and
 * must not inherit the write surface by prefix. An absent identity is unauthorized: the
 * section is not something to show optimistically before the portal has answered.
 * @param name - `window.__DATAOPS_USER__.name`, when known.
 * @returns whether the section should be registered.
 */
export function isOcrSettingsVisible(name: string | null | undefined): boolean {
  return typeof name === 'string' && OCR_SETTINGS_ROLES.includes(name)
}

/** The part of `window` this module reads. */
export interface VisibilityWindow {
  __DATAOPS_USER__?: { readonly name?: unknown } | null
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/** Options for {@link installConditionalSection}. */
export interface ConditionalSectionOptions {
  /** The window that carries the identity and the change event. */
  window: VisibilityWindow
  /** Register the section; returns its disposer. Only called while authorized. */
  register: () => (() => void) | undefined
  /** Optional extra signal (e.g. a MutationObserver on the account dataset). */
  observe?: (sync: () => void) => () => void
  /** Called when registration itself throws, so one failure does not kill the plugin. */
  onError?: (error: unknown) => void
}

/**
 * Register the section only while the current identity is authorized, and follow changes.
 *
 * The disposer removes the event listener and the extra observer, and disposes any section
 * currently registered. Calling it is what lets Cordis unload the plugin without leaving a
 * Settings row behind.
 * @param options - window, registrar, and optional observer/error hook.
 * @returns a disposer for the whole conditional contribution.
 */
export function installConditionalSection(options: ConditionalSectionOptions): () => void {
  let disposeSection: (() => void) | undefined
  const sync = (): void => {
    disposeSection?.()
    disposeSection = undefined
    const name = options.window.__DATAOPS_USER__?.name
    if (!isOcrSettingsVisible(typeof name === 'string' ? name : undefined)) return
    try {
      disposeSection = options.register()
    } catch (error) {
      options.onError?.(error)
    }
  }
  sync()
  const onChange = (): void => { sync() }
  options.window.addEventListener(ACCOUNT_CHANGED_EVENT, onChange)
  const disposeObserver = options.observe?.(sync)
  return () => {
    options.window.removeEventListener(ACCOUNT_CHANGED_EVENT, onChange)
    disposeObserver?.()
    disposeSection?.()
    disposeSection = undefined
  }
}
