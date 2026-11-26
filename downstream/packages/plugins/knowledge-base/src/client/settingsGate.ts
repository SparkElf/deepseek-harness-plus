/**
 * Visibility gate for the knowledge-base Settings section.
 *
 * The Settings surface is an operator tool, not a reader feature: only the
 * DataOps platform administrator roles may see it. The gate is deliberately a
 * separate module so the rule and the register/dispose lifecycle can be tested
 * without mounting React or a slot registry.
 *
 * The identity is presentation-only (`window.__DATAOPS_USER__`), posted by the
 *. Authorization for actual writes still lives in DataOps; hiding the
 * section is representation, and the Host routes refuse unauthorized callers
 * independently.
 *
 * @module @sparkelf/dsh-knowledge-base/client/settingsGate
 */

/** The event the account plugin dispatches after replacing `__DATAOPS_USER__`. */
export const DATAOPS_ACCOUNT_CHANGED_EVENT = 'dataops-account:changed'

/** Roles that may see and use the knowledge-base Settings section. */
export const KNOWLEDGE_SETTINGS_ROLES = ['超级管理员', '管理员'] as const

/** The presentation identity fields this gate reads. */
export interface SettingsIdentityLike {
  readonly name?: string | null
}

/** The window surface the gate reads and subscribes to. */
export interface SettingsWindowLike {
  readonly __DATAOPS_USER__?: SettingsIdentityLike | null
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/** Exactly the two DataOps platform roles; department admins are excluded. */
export function canSeeKnowledgeSettings(identity: SettingsIdentityLike | null | undefined): boolean {
  return identity?.name === '超级管理员' || identity?.name === '管理员'
}

/** Register one slot contribution; returns its disposer. */
export type SettingsRegister = () => () => void

/** Options keep the gate injectable for a unit test. */
export interface SettingsGateOptions {
  /** Register the section; called only while visible and not already registered. */
  readonly register: SettingsRegister
  /** Read the current identity; defaults to the live window. */
  readonly readIdentity?: () => SettingsIdentityLike | null | undefined
  /** Subscribe to identity changes; defaults to the window event. */
  readonly subscribe?: (listener: () => void) => () => void
  /**
   * Extra same-tab signal, mirroring the account bridge's dataset write. The event is
   * the contract; the observer exists because a/account bundle can publish the
   * first identity without dispatching it, and the section must appear on first paint.
   */
  readonly observe?: (sync: () => void) => () => void
}

/** A started gate with an explicit sync for tests and account events. */
export interface SettingsGate {
  /** Register if allowed and subscribe to future changes. */
  start(): void
  /** Run the visibility rule now; register or dispose as needed. */
  sync(): void
  /** Unsubscribe and dispose any live registration. */
  stop(): void
}

const defaultWindow = (): SettingsWindowLike | undefined => (
  typeof window === 'undefined' ? undefined : window as unknown as SettingsWindowLike
)

const defaultReadIdentity = (): SettingsIdentityLike | null | undefined => defaultWindow()?.__DATAOPS_USER__

const defaultSubscribe = (listener: () => void): (() => void) => {
  const target = defaultWindow()
  if (target === undefined) return () => undefined
  target.addEventListener(DATAOPS_ACCOUNT_CHANGED_EVENT, listener)
  return () => { target.removeEventListener(DATAOPS_ACCOUNT_CHANGED_EVENT, listener) }
}

const defaultObserve = (sync: () => void): (() => void) => {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => undefined
  const observer = new MutationObserver(() => { sync() })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-dataops-account-name'] })
  return () => { observer.disconnect() }
}

/**
 * Build a gate around one slot registration.
 *
 * The gate never registers twice: an account event that leaves the role unchanged is
 * a no-op, and a downgrade disposes the mounted section rather than merely hiding its
 * controls. That is the "content area must also not render" requirement.
 */
export function createSettingsGate(options: SettingsGateOptions): SettingsGate {
  const readIdentity = options.readIdentity ?? defaultReadIdentity
  const subscribe = options.subscribe ?? defaultSubscribe
  const observe = options.observe ?? defaultObserve
  let dispose: (() => void) | undefined
  let unsubscribe: (() => void) | undefined
  let disconnect: (() => void) | undefined
  let started = false

  const sync = (): void => {
    if (!started) return
    if (canSeeKnowledgeSettings(readIdentity())) {
      if (dispose === undefined) dispose = options.register()
    } else if (dispose !== undefined) {
      dispose()
      dispose = undefined
    }
  }

  return {
    start(): void {
      if (started) return
      started = true
      unsubscribe = subscribe(sync)
      disconnect = observe(sync)
      sync()
    },
    sync,
    stop(): void {
      if (!started) return
      started = false
      unsubscribe?.()
      unsubscribe = undefined
      disconnect?.()
      disconnect = undefined
      dispose?.()
      dispose = undefined
    },
  }
}
