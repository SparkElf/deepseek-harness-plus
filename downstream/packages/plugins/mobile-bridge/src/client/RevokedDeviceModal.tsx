/** In-app notice shown when the desktop revokes this phone session. */

import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

const REVOKED_MESSAGE = 'dsh-mobile-bridge:revoked'

function scanAgain(): void { location.assign('/bridge/?revoked=1') }

/** Present desktop revocation over the current Harness page and route every exit to pairing. */
export function RevokedDeviceModal({ t }: PropsLocale<'settingsMobileBridge'>) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent<{ type?: string } | null>): void => {
      if (event.data?.type === REVOKED_MESSAGE) setOpen(true)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => { navigator.serviceWorker.removeEventListener('message', onMessage) }
  }, [])

  return (
    <Modal
      open={open}
      onClose={scanAgain}
      title={t('revokedTitle')}
      closeLabel={t('scanAgain')}
      description={t('revokedDescription')}
      footer={<Button variant="primary" onClick={scanAgain}>{t('scanAgain')}</Button>}
    />
  )
}
