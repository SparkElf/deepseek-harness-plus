/**
 * Feedback submission over the portal bridge.
 *
 * The iframe holds no DataOps credential, so the portal is the only half that
 * can call the API. This module sends one request to `window.parent`, waits for
 * the matching result, and gives up after the agreed 15-second budget. The
 * payload carries what the operator typed; the portal attaches the bearer token
 * and the backend derives the author from that token, not from these fields.
 *
 * @module @sparkelf/dsh-dataops-account/client/feedback
 */

import { getIdentitySnapshot, getParentOrigin } from './identity.ts'

/** The three categories the form offers. */
export type FeedbackCategory = 'feature' | 'bug' | 'other'

/** What the form sends to the portal. */
export interface FeedbackDraft {
  readonly category: FeedbackCategory
  readonly content: string
  readonly contact: string
  readonly pageUrl: string
}

/** The result of one successful submission. */
export interface FeedbackSubmitResult {
  readonly id: string | null
}

interface PendingRequest {
  readonly resolve: (result: FeedbackSubmitResult) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const REQUEST_MESSAGE = 'dataops:feedback-submit'
const RESULT_MESSAGE = 'dataops:feedback-result'
/** Matches the portal's own abort budget; the UI shows a timeout error after this. */
const REQUEST_TIMEOUT_MS = 15_000

const pending = new Map<string, PendingRequest>()

const newRequestId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Install the result listener for the lifetime of the client plugin.
 * @returns disposer that rejects any in-flight request and removes the listener.
 */
export const installFeedbackBridge = (): (() => void) => {
  const onMessage = (event: MessageEvent): void => {
    // Same trust boundary as the identity handshake: only the embedding
    // document, and only a result for a request this frame is waiting on.
    if (event.source !== window.parent) return
    if (event.data === null || typeof event.data !== 'object') return
    const data = event.data as {
      readonly type?: unknown
      readonly requestId?: unknown
      readonly ok?: unknown
      readonly id?: unknown
      readonly error?: unknown
    }
    if (data.type !== RESULT_MESSAGE) return
    const requestId = typeof data.requestId === 'string' ? data.requestId : ''
    const request = pending.get(requestId)
    if (request === undefined) return
    pending.delete(requestId)
    clearTimeout(request.timer)
    if (data.ok === true) {
      request.resolve({ id: typeof data.id === 'string' && data.id !== '' ? data.id : null })
      return
    }
    const message = typeof data.error === 'string' && data.error.trim() !== ''
      ? data.error.trim()
      : 'feedback-failed'
    request.reject(new Error(message))
  }

  window.addEventListener('message', onMessage)
  return () => {
    window.removeEventListener('message', onMessage)
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('feedback-cancelled'))
    }
    pending.clear()
  }
}

/**
 * Submit one feedback draft through the portal.
 * @param draft - validated form values; the portal validates again.
 * @returns the created row id when the backend reported one.
 * @throws Error whose message is `timeout`, `not-embedded`, a portal error code,
 * or the backend's readable message.
 */
export const submitFeedback = (draft: FeedbackDraft): Promise<FeedbackSubmitResult> => {
  return new Promise<FeedbackSubmitResult>((resolve, reject) => {
    if (window.parent === window) {
      reject(new Error('not-embedded'))
      return
    }
    const requestId = newRequestId()
    const identity = getIdentitySnapshot()
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('timeout'))
    }, REQUEST_TIMEOUT_MS)
    pending.set(requestId, { resolve, reject, timer })
    // The origin is known once the identity handshake has run. `*` remains the
    // only target before that; the browser still delivers to this frame's
    // actual parent, and the payload carries no credential.
    window.parent.postMessage({
      type: REQUEST_MESSAGE,
      requestId,
      payload: {
        category: draft.category,
        content: draft.content,
        contact: draft.contact,
        pageUrl: draft.pageUrl,
        user: identity === null ? null : { id: identity.id, name: identity.name },
      },
    }, getParentOrigin() || '*')
  })
}