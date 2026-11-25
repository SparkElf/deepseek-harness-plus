import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { fetchReviewContext, reviewDemoMode } from './review-client.ts'
import { canSeeManagedSettings } from './settings-gate.ts'

/**
 * The sidebar glyph for the permission centre.
 *
 * The entry is hidden for a caller the Host reports as an ordinary user. This is a navigation
 * affordance, not the authorization decision: every permission-centre endpoint re-checks the
 * caller, and the page itself refuses to render without a management role.
 */
export function PermissionCenterIcon(): ReactNode {
  // Paint the shield on the first frame and hide it only once the Host says ordinary user. A
  // navigation affordance is not the authorization decision, and `canSeeManagedSettings()` is
  // false until the launcher label hydrates — waiting for it made the icon pop in a beat late.
  const [allowed, setAllowed] = useState(true)
  useEffect(() => {
    let live = true
    if (reviewDemoMode() || canSeeManagedSettings()) { setAllowed(true); return () => { live = false } }
    void fetchReviewContext().then((context) => {
      if (!live) return
      setAllowed(context !== null && context.role !== 'APP_USER')
    }).catch(() => { if (live) setAllowed(false) })
    return () => { live = false }
  }, [])
  if (!allowed) return null
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M9 2.2 14.5 4v4.4c0 3.1-2.1 5.6-5.5 7.4-3.4-1.8-5.5-4.3-5.5-7.4V4L9 2.2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="m6.7 8.8 1.6 1.6 3-3.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
