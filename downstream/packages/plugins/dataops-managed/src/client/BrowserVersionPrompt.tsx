/**
 * Browser-version notice.
 *
 * The workspace is a web app; the local browser bridge only supports current Chromium
 * releases. This banner is deliberately a sibling of the workspace-image banner: it uses
 * the same shell-overlay seat and the same quiet notice geometry, while keeping the
 * browser floor and the installer URL owned by this plugin.
 *
 * @module BrowserVersionPrompt
 */

import { useCallback, useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { en } from './locales.ts'
import styles from './WorkspaceUpgradePrompt.module.css'

/** Same-origin route served by the DataOps plugin's Host half. */
const BROWSER_BRIDGE_INSTALLER_PATH = '/api/dsh-skill-center/browser-bridge/installer'

/** Lowest Chromium major the local browser bridge supports. */
export const MIN_BROWSER_MAJOR = 150

export interface BrowserVersionPromptProps {
  /** Resolve one managed DataOps message key. */
  readonly t: (key: keyof typeof en) => string
}

/**
 * Extract the Chromium major from the user agent.
 *
 * `navigator.userAgentData` is preferred in modern Chromium; the UA fallback keeps
 * Firefox/Safari and older embedded WebViews from producing a false positive.
 */
export function chromiumMajor(ua: string): number | null {
  const edge = /Edg\/(\d+)/u.exec(ua)
  if (edge !== null) return Number(edge[1])
  const chrome = /(?:Chrome|Chromium|HeadlessChrome)\/(\d+)/u.exec(ua)
  return chrome === null ? null : Number(chrome[1])
}

/** Render the browser-version banner while the current browser is below the floor. */
export function BrowserVersionPrompt(props: BrowserVersionPromptProps) {
  const { t } = props
  const version = useMemo(
    () => (typeof navigator === 'undefined' ? null : chromiumMajor(navigator.userAgent)),
    [],
  )
  const [dismissed, setDismissed] = useState(false)

  const download = useCallback((): void => {
    // The installer endpoint responds with Content-Disposition: attachment; navigating
    // keeps the download same-origin and avoids an unverified blob URL.
    window.location.assign(BROWSER_BRIDGE_INSTALLER_PATH)
  }, [])

  if (version === null || version >= MIN_BROWSER_MAJOR || dismissed) return null

  return (
    <div className={styles.banner} role="status" aria-live="polite">
      <div className={styles.copy}>
        <strong className={styles.title}>{t('browserVersionTitle')}</strong>
        <span className={styles.body}>
          {t('browserVersionBody').replace('{version}', String(version)).replace('{minimum}', String(MIN_BROWSER_MAJOR))}
        </span>
      </div>
      <div className={styles.actions}>
        <Button variant="primary" size="sm" onClick={download}>{t('browserVersionAction')}</Button>
        <Button variant="ghost" size="sm" onClick={() => { setDismissed(true) }}>{t('browserVersionLater')}</Button>
      </div>
    </div>
  )
}
