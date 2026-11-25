/**
 * The DataOps identity inside the DSH workbench iframe.
 *
 * DSH never has a DeepSeek account in this deployment: the portal already
 * authenticated the operator and embeds DSH as a sibling origin. The portal
 * therefore posts a presentation-only identity record after every iframe load,
 * and this module keeps the latest record plus a local copy so a reload paints
 * the right launcher before the next message arrives.
 *
 * The message carries no credential and grants nothing: authorization stays
 * with the DataOps JWT the gateway already enforced. This module's only job is
 * to decide which role badge and label the launcher shows.
 *
 * The store lives on `window` rather than in module scope on purpose. The client
 * bundle can be evaluated more than once in one page (a reload, or the HMR
 * receiver re-running the factory); a module-local store would then split into
 * two, and a launcher rendered by the first evaluation would keep waiting while
 * the second evaluation received the identity. One window-scoped store makes
 * every evaluation observe the same record.
 *
 * @module @sparkelf/dsh-dataops-account/client/identity
 */

import { useSyncExternalStore } from 'react'

/** Presentation identity posted by the DataOps portal. */
export interface DataOpsIdentity {
  readonly id: string
  readonly username: string
  readonly displayName: string
  /** Primary label: the role name DataOps renders (falling back to the account name). */
  readonly name: string
  /** Inline data-URL badge produced by DataOps; empty when there is none. */
  readonly avatarUrl: string
  /** First grapheme of `name`, used by the initial-disc fallback. */
  readonly initial: string
}

type IdentityPayload = {
  readonly type: 'dataops:user'
  readonly version?: number
  readonly user?: unknown
}

type ParentMessage = {
  readonly type?: unknown
}

type Listener = () => void

interface AccountStore {
  snapshot: DataOpsIdentity | null
  readonly listeners: Set<Listener>
  parentOrigin: string
  restorers: ReturnType<typeof setTimeout>[]
}

const STORE_KEY = '__DATAOPS_ACCOUNT_STORE__'
const STORAGE_KEY = 'dataops-account:identity:v2'
const USER_MESSAGE = 'dataops:user'
const REQUEST_MESSAGE = 'dataops:user-request'
const APPLIED_MESSAGE = 'dataops:user-applied'
const AUTH_UPDATED_MESSAGE = 'dataops-auth-updated'
const RETRY_DELAYS_MS = [0, 150, 500, 1200, 3000, 6000, 10_000, 20_000] as const

declare global {
  interface Window {
    /** Latest identity, for diagnosis and for other DataOps plugins. */
    __DATAOPS_USER__?: DataOpsIdentity | null
    /** Singleton identity store shared by every evaluation of this bundle. */
    __DATAOPS_ACCOUNT_STORE__?: AccountStore
  }
}

const store = (window.__DATAOPS_ACCOUNT_STORE__ ??= {
  snapshot: null,
  listeners: new Set<Listener>(),
  parentOrigin: '',
  restorers: [],
})

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const firstGrapheme = (value: string): string => {
  const first = Array.from(value)[0] ?? 'D'
  return first.toUpperCase()
}

/**
 * Accept only inline images.
 *
 * DataOps renders the role badge itself as an SVG data URL, so a remote photo
 * is never needed here and is deliberately ignored: an external URL can fail
 * slowly on an intranet and would leave the launcher blank instead of the
 * predictable role disc.
 */
const safeAvatarUrl = (value: unknown): string => {
  const raw = text(value)
  if (raw.startsWith('data:image/') || raw.startsWith('blob:')) return raw
  return ''
}

/** Normalize one untrusted user record; `null` when there is nobody to show. */
export const normalizeIdentity = (value: unknown): DataOpsIdentity | null => {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const username = text(record.username)
  const displayName = text(record.displayName)
  const roleName = text(record.roleName)
  // The launcher is a role badge, not a person card: prefer the role name so
  // the settings gate can read the same name the avatar displays.
  const name = roleName !== '' ? roleName : displayName !== '' ? displayName : username
  if (name === '') return null
  return {
    id: text(record.id),
    username,
    displayName,
    name,
    avatarUrl: safeAvatarUrl(record.avatarUrl),
    initial: firstGrapheme(name),
  }
}

const writeDocumentState = (identity: DataOpsIdentity | null, avatarState?: 'image' | 'initial'): void => {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.dataopsAccountId = identity?.id ?? ''
  root.dataset.dataopsAccountName = identity?.name ?? ''
  root.dataset.dataopsAccountAvatar = identity === null
    ? 'pending'
    : avatarState ?? (identity.avatarUrl === '' ? 'initial' : 'image')
}

const readStored = (): DataOpsIdentity | null => {
  try {
    // Local rather than session storage: a second tab (or a refreshed tab whose
    // portal bundle predates the handshake) then paints the last known role
    // instead of the pending placeholder. The portal posts a fresh record on
    // every load and that record wins immediately.
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    return normalizeIdentity(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

const publish = (identity: DataOpsIdentity | null): void => {
  store.snapshot = identity
  window.__DATAOPS_USER__ = identity
  try {
    if (identity === null) window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(identity))
  } catch {
    /* Private mode or a full quota: the in-memory copy still renders. */
  }
  writeDocumentState(identity)
  // The dataset is written first: consumers reading the attribute in the event
  // handler must see the same identity the event describes. The event fires for
  // the initial record too, so gates do not need a DOM observer to bootstrap.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('dataops-account:changed', { detail: identity }))
  }
  for (const listener of [...store.listeners]) listener()
}

const clearRestorers = (): void => {
  for (const timer of store.restorers) clearTimeout(timer)
  store.restorers = []
}

const requestIdentity = (): void => {
  if (typeof window === 'undefined' || window.parent === window) return
  // A request carries no identity, so `*` is the only target available before
  // the first reply teaches us the parent's origin.
  window.parent.postMessage({ type: REQUEST_MESSAGE, source: 'dsh-dataops-account' }, store.parentOrigin || '*')
}

const scheduleRequests = (): void => {
  clearRestorers()
  if (store.snapshot !== null) return
  store.restorers = RETRY_DELAYS_MS.map(delay => setTimeout(() => {
    if (store.snapshot === null) requestIdentity()
  }, delay))
}

const acknowledge = (identity: DataOpsIdentity): void => {
  if (typeof window === 'undefined' || window.parent === window) return
  window.parent.postMessage({ type: APPLIED_MESSAGE, userId: identity.id }, store.parentOrigin || '*')
}

/** Latest identity, or `null` before the portal has answered. */
export const getIdentitySnapshot = (): DataOpsIdentity | null => store.snapshot

/** The parent origin learned from the first identity message; `''` before that. */
export const getParentOrigin = (): string => store.parentOrigin

/** Subscribe to identity changes (the reducer is the whole record). */
export const subscribeIdentity = (listener: Listener): (() => void) => {
  store.listeners.add(listener)
  return () => {
    store.listeners.delete(listener)
  }
}

/** React binding used by the launcher. */
export const useIdentity = (): DataOpsIdentity | null =>
  useSyncExternalStore(subscribeIdentity, getIdentitySnapshot, getIdentitySnapshot)

/** Mirror the image-to-disc fallback into the diagnostic document attributes. */
export const reportAvatarFallback = (): void => {
  if (store.snapshot !== null) writeDocumentState(store.snapshot, 'initial')
}

/**
 * Install the portal bridge for the lifetime of the client plugin.
 *
 * Presentation data only: the sender must be this frame's parent, and the
 * payload is normalized before it is allowed near the DOM. No credential is
 * read, stored, or forwarded.
 *
 * @returns disposer that removes the listener and pending retries.
 */
export const installIdentityBridge = (): (() => void) => {
  // Another evaluation may already have published a fresher record; storage is
  // only the starting point, never an overwrite of live state.
  if (store.snapshot === null) store.snapshot = readStored()
  window.__DATAOPS_USER__ = store.snapshot
  writeDocumentState(store.snapshot)
  // Initial bootstrap (cached or pending) also announces itself; a gate opened
  // before the first portal message must already know "pending" and re-check on
  // the real identity that follows.
  window.dispatchEvent(new CustomEvent('dataops-account:changed', { detail: store.snapshot }))

  const onMessage = (event: MessageEvent): void => {
    // Only the embedding document can speak for the DataOps user. `source` is
    // the browser-enforced identity of the sender; `origin` is remembered so
    // later requests/acks are addressed to one origin instead of `*`.
    if (event.source !== window.parent) return
    const data = event.data as ParentMessage | null
    if (data === null || typeof data !== 'object') return

    if (data.type === AUTH_UPDATED_MESSAGE) {
      requestIdentity()
      return
    }

    if (data.type !== USER_MESSAGE) return
    const payload = data as IdentityPayload
    const identity = normalizeIdentity(payload.user)
    if (identity === null) return
    if (event.origin !== '' && event.origin !== 'null') store.parentOrigin = event.origin
    clearRestorers()
    publish(identity)
    acknowledge(identity)
  }

  // A tab restored from the back/forward cache never re-runs `apply`, and a
  // frame that was hidden while the portal posted can miss the burst; asking
  // again whenever the frame becomes visible closes both gaps.
  const requestIfPending = (): void => {
    if (store.snapshot === null) {
      requestIdentity()
      scheduleRequests()
    }
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') requestIfPending()
  }

  window.addEventListener('message', onMessage)
  window.addEventListener('focus', requestIfPending)
  window.addEventListener('pageshow', requestIfPending)
  document.addEventListener('visibilitychange', onVisibility)
  requestIdentity()
  scheduleRequests()

  return () => {
    window.removeEventListener('message', onMessage)
    window.removeEventListener('focus', requestIfPending)
    window.removeEventListener('pageshow', requestIfPending)
    document.removeEventListener('visibilitychange', onVisibility)
    clearRestorers()
  }
}

/** Test-only reset of module state. */
export const resetIdentityForTests = (): void => {
  store.snapshot = null
  store.parentOrigin = ''
  clearRestorers()
  store.listeners.clear()
}