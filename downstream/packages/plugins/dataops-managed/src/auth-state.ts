/**
 * Whether the stored DataOps credential is still accepted, observed rather than guessed.
 *
 * Every DataOps call this plugin makes already knows the answer: a 401 is the server saying the
 * caller's session has ended. Those answers used to be swallowed at each call site — each one
 * returned `undefined` and moved on — which turned "your session expired" into "this feature
 * happens to be empty". That is the failure this module removes: the calls still degrade
 * gracefully, but the reason is recorded once, in a place the interface can read.
 *
 * The state is deliberately tiny and stuck in this process. It is not a token cache and it does
 * not decide authorization — DataOps remains the only authority. It exists because a person
 * looking at the workspace cannot see a 401 that was handled three layers down, and "sign in
 * again" is only actionable if it is shown while it is still true.
 *
 * @module auth-state
 */

/** What the last DataOps answer said about the stored credential. */
export type AuthState = 'unknown' | 'valid' | 'expired'

let state: AuthState = 'unknown'

/** One observer of the recorded credential observation. */
export type AuthStateListener = (state: AuthState) => void

const listeners = new Set<AuthStateListener>()

/**
 * Observe every recorded transition.
 *
 * The tool manager uses this to drop its disclosure as soon as any DataOps call reports a 401:
 * the scope that produced the tool list can no longer be trusted, and waiting for another
 * explicit sync would leave tools offered against an ended session. Listener failures are
 * contained so a broken observer cannot turn a credential observation into a failed call.
 * @param listener - Called with the new state after it is recorded.
 * @returns The exact unsubscriber.
 */
export const onAuthStateChange = (listener: AuthStateListener): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Record one observation and notify observers. */
const setState = (next: AuthState): void => {
  state = next
  for (const listener of listeners) {
    try { listener(next) } catch { /* observation must not fail the operation that saw it */ }
  }
}

/**
 * Record that a DataOps call was accepted.
 *
 * Called on any non-401 answer, including ones that carry a refusal for another reason: a 403
 * says the session is fine and the permission is not, so it must not raise the sign-in prompt.
 */
export const noteAccepted = (): void => {
  setState('valid')
}

/** Record that DataOps refused the credential, which means the session is over. */
export const noteExpired = (): void => {
  setState('expired')
}

/**
 * Read the current observation.
 *
 * @returns `unknown` before any call has completed, then what the last one said.
 */
export const currentAuthState = (): AuthState => state

/**
 * Test-only reset, so one case cannot leak its observation into the next.
 */
export const resetAuthState = (): void => {
  setState('unknown')
}
