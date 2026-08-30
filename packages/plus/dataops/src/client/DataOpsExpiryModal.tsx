import { useEffect } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { DataOpsClientInjected, DataOpsInjectedProps } from './contract.ts'
import { createDataOpsStore, isLoginExpired } from './store.ts'
import styles from './DataOpsSection.module.css'

/** Full props for the frame-wide DataOps authorization prompt. */
export type DataOpsExpiryModalProps =
  & PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createDataOpsStore>>
  & DataOpsInjectedProps

/**
 * Render the frame-wide expired-sign-in prompt and own its browser lifecycle.
 * @param props - Root-scoped overlay owner, shared store, and injected callbacks.
 * @returns The modal contribution, or nothing before injection or expiry.
 */
export function DataOpsExpiryModal(props: DataOpsExpiryModalProps) {
  const { t, start, openAuthorization } = props
  if (t === undefined || start === undefined || openAuthorization === undefined) return null
  return <Loaded {...props} t={t} start={start} openAuthorization={openAuthorization} />
}

function Loaded(props: DataOpsExpiryModalProps & Pick<DataOpsClientInjected, 't' | 'start' | 'openAuthorization'>) {
  const state = props.useStore(value => value)
  useEffect(() => props.start(), [props.start])
  const open = isLoginExpired(state.status) && !state.expiryPromptDismissed
  return (
    <Modal
      open={open}
      onClose={props.actions.dismissExpiryPrompt}
      title={props.t('loginExpired')}
      closeLabel={props.t('close')}
      description={props.t('loginExpiredHint')}
      footer={(
        <>
          <Button variant="ghost" onClick={props.actions.dismissExpiryPrompt}>{props.t('later')}</Button>
          <Button variant="primary" onClick={props.openAuthorization}>{props.t('signInAgain')}</Button>
        </>
      )}
    >
      {state.failure !== undefined && <p className={styles.error} role="alert">{props.t(state.failure)}</p>}
    </Modal>
  )
}
