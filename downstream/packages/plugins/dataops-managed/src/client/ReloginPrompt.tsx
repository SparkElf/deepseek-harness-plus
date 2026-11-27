/**
 * The "sign in again" prompt shown when this workspace's DataOps session has ended.
 *
 * The failure it reports used to be invisible. Every DataOps call handles a 401 by degrading to
 * an empty result, which is right for one panel but wrong for the operator: settings, shared
 * models and the skill plaza all render as "nothing here" while the real cause is that nobody is
 * signed in any more. This prompt names that state once, with the one action that clears it.
 *
 * It reports and nothing more. It does not retry, expire, or re-authenticate — the portal owns
 * the login form and is the only thing that can issue a session. Its action navigates the parent
 * portal when the frame's ancestor origin is known, and opens the portal separately when the
 * browser blocks top-level navigation from the frame.
 *
 * @module ReloginPrompt
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AuthState } from '../auth-state.ts'

/** How often to re-read the observed auth state. */
const POLL_MS = 15_000

/** What the Host route answers. */
interface AuthStateReply {
  readonly state?: unknown
}

/**
 * Read the observed credential state from the Host.
 *
 * A failed read says nothing about the credential: this route is served by the same process that
 * serves the page, so an unreachable route means the Web server is busy or restarting, not that
 * anyone was signed out. Returning `undefined` keeps a transient error from raising a sign-in
 * prompt, which would be a lie the operator cannot act on.
 *
 * @returns the reported state, or `undefined` when it could not be read.
 */
const readAuthState = async (): Promise<AuthState | undefined> => {
  try {
    const response = await fetch(new URL('/integrations/dataops/auth-state', window.location.origin), {
      credentials: 'same-origin',
    })
    if (!response.ok) return undefined
    const body = await response.json() as AuthStateReply
    const state = body.state
    return state === 'expired' || state === 'valid' || state === 'unknown' ? state : undefined
  } catch {
    return undefined
  }
}

/** The copy this prompt needs, bound by its host surface. */
export interface ReloginPromptProps {
  /** Resolve one of the prompt's own strings. */
  readonly t: (key: 'reloginTitle' | 'reloginBody' | 'reloginAction' | 'reloginDismiss') => string
}

/**
 * Watch for an ended DataOps session and say so.
 *
 * @param props.t - localized copy resolver.
 * @returns the dialog while the session is known to have ended, otherwise `null`.
 */
export function ReloginPrompt(props: ReloginPromptProps) {
  const { t } = props
  const [expired, setExpired] = useState(false)
  // Dismissal is per-outage, not permanent: the state stays `expired`, so without this the dialog
  // would reopen on the next poll and trap the operator behind a modal they cannot leave.
  // A session that comes back resets the flag, so the next outage prompts again.
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      const state = await readAuthState()
      if (cancelled || state === undefined) return
      setExpired(state === 'expired')
      if (state !== 'expired') setDismissed(false)
    }
    void tick()
    const timer = setInterval(() => { void tick() }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const dismiss = useCallback((): void => { setDismissed(true) }, [])

  if (!expired || dismissed) return null
  return (
    <Modal
      open
      onClose={dismiss}
      title={t('reloginTitle')}
      closeLabel={t('reloginDismiss')}
      description={t('reloginBody')}
      footer={(
        <>
          <Button onClick={dismiss}>{t('reloginDismiss')}</Button>
          {/* The portal is the only issuer of a new session, and this frame must never navigate its
              parent: doing so replaced the whole workspace view with the portal home while the user
              was working. Open the portal separately; after signing in there, the portal announces
              the new session through the same postMessage this plugin already listens for, and the
              frame re-synchronises in place. */}
          <Button variant="primary" onClick={() => {
            const portalOrigin = window.location.ancestorOrigins?.[0]
              ?? (document.referrer === '' ? undefined : new URL(document.referrer).origin)
            if (portalOrigin === undefined || portalOrigin === window.location.origin) {
              window.location.reload()
              return
            }
            window.open(`${portalOrigin}/`, '_blank', 'noopener')
          }}>
            {t('reloginAction')}
          </Button>
        </>
      )}
    />
  )
}
