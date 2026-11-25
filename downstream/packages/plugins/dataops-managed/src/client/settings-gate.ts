// @ts-nocheck
/**
 * Whether the managed DataOps settings section may be registered at all.
 *
 * Registration is the gate, not a CSS class: an ordinary user's profile should not contain a
 * section whose controls they may not use. The identity record is presentation-only and arrives
 * from the portal after the iframe loads, so the registration follows it instead of reading it
 * once at startup. Authorization still lives in DataOps; this only keeps a forbidden panel out of
 * the interface.
 */

/** The two DataOps role labels allowed to see the managed settings panel. */
const MANAGED_SETTINGS_ROLES: ReadonlySet<string> = new Set(['超级管理员', '管理员'])

/** The shared identity record the DataOps account plugin publishes on `window`. */
interface DataOpsUserWindow extends Window {
  __DATAOPS_USER__?: { name?: unknown } | null
  __DATAOPS_ACCOUNT_STORE__?: { listeners?: Set<() => void> }
}

/** The account launcher's visible label, which is painted before the window record settles. */
function domAccountName(): string | null {
  if (typeof document === 'undefined') return null
  // The launcher's label is one short span. Reading `querySelector` is not enough: the same
  // attribute can sit on a full-page wrapper whose text is the entire application, which would
  // never equal a role label. Prefer the shortest non-empty candidate.
  const texts = [...document.querySelectorAll('[data-dataops-account-name]')]
    .map(element => element.textContent?.trim() ?? '')
    .filter(text => text !== '' && text.length <= 30)
    .sort((left, right) => left.length - right.length)
  return texts[0] ?? null
}

/** Read the current role label without trusting any other field. */
export function currentManagedSettingsRole(): string | null {
  if (typeof window === 'undefined') return null
  // The launcher's label is the first identity signal on screen; the window record follows.
  const domName = domAccountName()
  if (domName !== null) return domName
  const name = (window as DataOpsUserWindow).__DATAOPS_USER__?.name
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : null
}

/** Whether the current identity may see the managed DataOps settings section. */
export function canSeeManagedSettings(): boolean {
  const role = currentManagedSettingsRole()
  return role !== null && MANAGED_SETTINGS_ROLES.has(role)
}

/**
 * Observe identity changes.
 *
 * The account plugin keeps one store on `window`; subscribing to its listener set catches the
 * in-page update even before the portal's DOM event. The event is kept as a second signal because
 * a future portal may publish the event without touching the store this plugin reads.
 */
export function subscribeManagedSettingsVisibility(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const store = (window as DataOpsUserWindow).__DATAOPS_ACCOUNT_STORE__
  store?.listeners?.add(listener)
  window.addEventListener('dataops-account:changed', listener)

  /**
   * The first identity can arrive before this module subscribes (or replace the account store
   * object), which is why the sidebar used to show only the sections whose gate happened to run
   * later. The launcher's label is a DOM fact either way, so watch it as the fallback signal.
   */
  let observed = domAccountName()
  const observer = typeof MutationObserver === 'undefined' || typeof document === 'undefined'
    ? undefined
    : new MutationObserver(() => {
      const next = domAccountName()
      if (next === observed) return
      observed = next
      listener()
    })
  observer?.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-dataops-account-name'],
  })
  // Reconcile once after the current frame, when the first paint (and its label) is complete.
  if (observed !== null) queueMicrotask(listener)

  return () => {
    store?.listeners?.delete(listener)
    window.removeEventListener('dataops-account:changed', listener)
    observer?.disconnect()
  }
}
