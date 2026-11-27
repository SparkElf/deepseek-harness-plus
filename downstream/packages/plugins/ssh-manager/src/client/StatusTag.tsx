/**
 * One connection-result tag shared by the wizard, the host detail header, and the list.
 *
 * The tone is the semantic part (`testing` / `ok` / `fail` / `idle`); callers own the
 * translated label so the tag never carries copy of its own.
 */
import { VscCircleFilled, VscError, VscLoading, VscPass } from 'react-icons/vsc'
import css from './SshManager.module.css'

export type StatusTone = 'idle' | 'testing' | 'ok' | 'fail'

export interface StatusTagProps {
  tone: StatusTone
  label: string
  /** Full reason or fingerprint, exposed through the title attribute. */
  detail?: string
}

export function StatusTag({ tone, label, detail }: StatusTagProps) {
  const Icon = tone === 'testing' ? VscLoading : tone === 'ok' ? VscPass : tone === 'fail' ? VscError : VscCircleFilled
  return <span
    className={css.statusTag}
    data-tone={tone}
    role="status"
    aria-live="polite"
    title={detail === undefined ? label : detail}
  >
    <Icon aria-hidden="true" className={tone === 'testing' ? css.spin : undefined} />
    <span>{label}</span>
  </span>
}
