/**
 * Three-step connection wizard: identity → authentication → advanced options.
 *
 * Step validation is local and inline; the connection test may run at any step because
 * it only needs the identity fields. A failed test never blocks saving: the plan's
 * contract is that an unreachable-but-configured host is still inventory, and opening it
 * later retries on demand.
 */
import { useRef, useState } from 'react'
import { VscChevronLeft, VscChevronRight, VscClose, VscKey, VscLock, VscPlug, VscPulse, VscSave, VscShield } from 'react-icons/vsc'
import type { SshCluster, SshCredentialInput, SshEnvironment, SshHost } from '../types.ts'
import {
  advancedErrors, canTestHost, credentialErrors, hasErrors, identityErrors, WIZARD_STEPS,
  type FieldErrors, type WizardStep,
} from './model.ts'
import { Select, type SelectOption } from './Select.tsx'
import { StatusTag, type StatusTagProps } from './StatusTag.tsx'
import { useT, type TranslationKey } from './i18n.tsx'
import css from './SshManager.module.css'

const ENVIRONMENTS: SshEnvironment[] = ['development', 'testing', 'staging', 'production', 'other']
const ENVIRONMENT_LABELS: Record<SshEnvironment, TranslationKey> = {
  development: 'environment.development',
  testing: 'environment.testing',
  staging: 'environment.staging',
  production: 'environment.production',
  other: 'environment.other',
}
const STEP_KEYS: Array<{ id: WizardStep; label: TranslationKey; hint: TranslationKey }> = [
  { id: 0, label: 'wizard.step.identity', hint: 'wizard.step.identityHint' },
  { id: 1, label: 'wizard.step.auth', hint: 'wizard.step.authHint' },
  { id: 2, label: 'wizard.step.advanced', hint: 'wizard.step.advancedHint' },
]

export interface ConnectionWizardProps {
  mode: 'create' | 'edit'
  host: SshHost
  credential: SshCredentialInput
  clusters: SshCluster[]
  hosts: SshHost[]
  busy: boolean
  probing: boolean
  testTag: StatusTagProps | null
  onChangeHost(next: SshHost): void
  onChangeCredential(next: SshCredentialInput): void
  onTest(): void
  onSave(): void
  onClose(): void
  onProbe(): void
}

export function ConnectionWizard({
  mode, host, credential, clusters, hosts, busy, probing, testTag,
  onChangeHost, onChangeCredential, onTest, onSave, onClose, onProbe,
}: ConnectionWizardProps) {
  const t = useT()
  const [step, setStep] = useState<WizardStep>(0)
  const [touched, setTouched] = useState<Partial<Record<string, boolean>>>({})
  const keyInput = useRef<HTMLInputElement | null>(null)

  const clustersOptions: SelectOption[] = [{ value: '', label: t('inventory.unclustered') }, ...clusters.map(cluster => ({ value: cluster.id, label: cluster.name }))]
  const environmentOptions: SelectOption[] = ENVIRONMENTS.map(value => ({ value, label: t(ENVIRONMENT_LABELS[value]) }))
  const jumpOptions: SelectOption[] = [{ value: '', label: t('host.none') }, ...hosts.filter(candidate => candidate.id !== host.id).map(candidate => ({ value: candidate.id, label: candidate.name, description: candidate.username + '@' + candidate.hostname }))]

  const errors = (): FieldErrors => ({
    ...identityErrors(host),
    ...credentialErrors(host, credential, host.credentialConfigured && mode === 'edit'),
    ...advancedErrors(host, hosts),
  })
  const currentErrors = errors()
  const fieldInvalid = (field: keyof FieldErrors): boolean => touched[field] === true && currentErrors[field] === true
  const markStep = (target: WizardStep): void => {
    setTouched(current => {
      const next = { ...current }
      if (target >= 0) {
        for (const field of Object.keys(identityErrors(host)) as Array<keyof FieldErrors>) next[field] = true
      }
      if (target >= 1) {
        for (const field of Object.keys(credentialErrors(host, credential, host.credentialConfigured && mode === 'edit')) as Array<keyof FieldErrors>) next[field] = true
      }
      if (target >= 2) {
        for (const field of Object.keys(advancedErrors(host, hosts)) as Array<keyof FieldErrors>) next[field] = true
      }
      return next
    })
  }
  const goTo = (target: WizardStep): void => {
    if (target > step) {
      // Forward navigation validates every step it passes through, not only the target.
      const blocked = (step <= 0 && hasErrors(identityErrors(host)))
        || (step <= 1 && target > 1 && hasErrors(credentialErrors(host, credential, host.credentialConfigured && mode === 'edit')))
      for (let index = step; index < target; index++) markStep(index as WizardStep)
      if (blocked) return
    }
    setStep(target)
  }
  const next = (): void => {
    markStep(step)
    const blocked = (step === 0 && hasErrors(identityErrors(host)))
      || (step === 1 && hasErrors(credentialErrors(host, credential, host.credentialConfigured && mode === 'edit')))
    if (blocked) return
    if (step < 2) setStep((step + 1) as WizardStep)
  }
  const save = (): void => {
    markStep(2)
    if (hasErrors(identityErrors(host))) { setStep(0); return }
    onSave()
  }
  const pickKeyFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    const text = await file.text()
    onChangeCredential({ ...credential, privateKey: text })
  }

  const authOptions: Array<{ value: SshHost['authKind']; label: TranslationKey; description: TranslationKey; icon: typeof VscKey }> = [
    { value: 'password', label: 'auth.password', description: 'auth.passwordDescription', icon: VscLock },
    { value: 'private-key', label: 'auth.privateKey', description: 'auth.privateKeyDescription', icon: VscKey },
    { value: 'agent', label: 'auth.agent', description: 'auth.agentDescription', icon: VscPlug },
  ]

  return <div className={css.backdrop}>
    <div className={css.dialog} role="dialog" aria-modal="true" aria-label={t(mode === 'create' ? 'dialog.newConnection' : 'dialog.editConnection')} data-wizard>
      <header>
        <div><strong>{t(mode === 'create' ? 'dialog.newConnection' : 'dialog.editConnection')}</strong><span>{t('wizard.subtitle')}</span></div>
        <button type="button" className={css.iconButton} aria-label={t('action.close')} onClick={onClose}><VscClose /></button>
      </header>

      <nav className={css.stepper} aria-label={t('wizard.stepsLabel')}>
        {STEP_KEYS.map((item, index) => <button
          type="button"
          key={item.id}
          data-active={step === item.id}
          data-complete={step > item.id}
          aria-current={step === item.id ? 'step' : undefined}
          aria-label={t('wizard.goToStep', { index: (index + 1).toString(), name: t(item.label) })}
          onClick={() => { goTo(item.id) }}
        >
          <i>{step > item.id ? '✓' : (index + 1).toString()}</i>
          <span><strong>{t(item.label)}</strong><small>{t(item.hint)}</small></span>
        </button>)}
      </nav>

      <div className={css.wizardBody}>
        {step === 0 && <div className={css.wizardGrid}>
          <label className={css.full} data-invalid={fieldInvalid('name')}>{t('field.name')}<input autoFocus value={host.name} aria-invalid={fieldInvalid('name')} onChange={event => { onChangeHost({ ...host, name: event.target.value }) }} />{fieldInvalid('name') && <small className={css.fieldError}>{t('wizard.error.name')}</small>}</label>
          <label data-invalid={fieldInvalid('hostname')}>{t('field.hostname')}<input value={host.hostname} aria-invalid={fieldInvalid('hostname')} placeholder={t('wizard.placeholder.hostname')} onChange={event => { onChangeHost({ ...host, hostname: event.target.value }) }} />{fieldInvalid('hostname') && <small className={css.fieldError}>{t('wizard.error.hostname')}</small>}</label>
          <label data-invalid={fieldInvalid('port')}>{t('field.port')}<input type="number" min={1} max={65535} value={host.port} aria-invalid={fieldInvalid('port')} onChange={event => { onChangeHost({ ...host, port: Number(event.target.value) }) }} />{fieldInvalid('port') && <small className={css.fieldError}>{t('wizard.error.port')}</small>}</label>
          <label data-invalid={fieldInvalid('username')}>{t('field.user')}<input value={host.username} aria-invalid={fieldInvalid('username')} placeholder={t('wizard.placeholder.user')} onChange={event => { onChangeHost({ ...host, username: event.target.value }) }} />{fieldInvalid('username') && <small className={css.fieldError}>{t('wizard.error.user')}</small>}</label>
          <label>{t('field.environment')}<Select label={t('field.environment')} value={host.environment} options={environmentOptions} onChange={value => { onChangeHost({ ...host, environment: value as SshEnvironment }) }} /></label>
          <label>{t('field.cluster')}<Select label={t('field.cluster')} value={host.clusterId ?? ''} options={clustersOptions} onChange={value => { onChangeHost({ ...host, clusterId: value === '' ? null : value }) }} /></label>
          <label className={css.full}>{t('field.tags')}<input value={host.tags.join(', ')} placeholder={t('field.tagsPlaceholder')} onChange={event => { onChangeHost({ ...host, tags: event.target.value.split(',').map(tag => tag.trim()).filter(Boolean) }) }} /></label>
        </div>}

        {step === 1 && <div className={css.wizardGrid}>
          <div className={css.full} role="radiogroup" aria-label={t('field.authentication')}>
            {authOptions.map(option => {
              const Icon = option.icon
              return <button
                type="button"
                role="radio"
                key={option.value}
                aria-checked={host.authKind === option.value}
                data-auth={option.value}
                data-active={host.authKind === option.value}
                className={css.authCard}
                onClick={() => { onChangeHost({ ...host, authKind: option.value }); onChangeCredential({}) }}
              >
                <Icon aria-hidden="true" />
                <span><strong>{t(option.label)}</strong><small>{t(option.description)}</small></span>
              </button>
            })}
          </div>
          {host.authKind === 'password' && <label className={css.full} data-invalid={fieldInvalid('credential')}>{t('field.password')}<input type="password" autoComplete="new-password" value={credential.password ?? ''} aria-invalid={fieldInvalid('credential')} placeholder={host.credentialConfigured && mode === 'edit' ? t('field.keepCredential') : t('wizard.placeholder.password')} onChange={event => { onChangeCredential({ password: event.target.value }) }} />{fieldInvalid('credential') && <small className={css.fieldError}>{t('wizard.error.credential')}</small>}<small className={css.fieldHint}>{t('wizard.passwordHint')}</small></label>}
          {host.authKind === 'private-key' && <>
            <label className={css.full} data-invalid={fieldInvalid('credential')}>{t('field.privateKey')}
              <textarea value={credential.privateKey ?? ''} aria-invalid={fieldInvalid('credential')} placeholder={host.credentialConfigured && mode === 'edit' ? t('field.keepCredential') : t('field.privateKeyPlaceholder')} onChange={event => { onChangeCredential({ privateKey: event.target.value }) }} />
              {fieldInvalid('credential') && <small className={css.fieldError}>{t('wizard.error.credential')}</small>}
              <button type="button" className={css.inlineAction} onClick={() => { keyInput.current?.click() }}>{t('wizard.chooseKeyFile')}</button>
              <input ref={keyInput} className={css.hiddenInput} type="file" aria-label={t('wizard.chooseKeyFile')} onChange={event => { void pickKeyFile(event.target.files?.[0]) }} />
            </label>
            <label>{t('field.passphrase')}<input type="password" autoComplete="new-password" value={credential.passphrase ?? ''} onChange={event => { onChangeCredential({ ...credential, passphrase: event.target.value }) }} /></label>
          </>}
          {host.authKind === 'agent' && <div className={css.full}><div className={css.hintBox}><VscShield aria-hidden="true" /><span><strong>{t('auth.agent')}</strong><small>{t('wizard.agentHint')}</small></span></div></div>}
          {host.credentialConfigured && mode === 'edit' && <div className={css.full}><div className={css.hintBox}><VscShield aria-hidden="true" /><span><small>{t('wizard.credentialStored')}</small></span></div></div>}
        </div>}

        {step === 2 && <div className={css.wizardGrid}>
          <label data-invalid={fieldInvalid('jumpHost')}>{t('field.jumpHost')}<Select label={t('field.jumpHost')} value={host.jumpHostId ?? ''} options={jumpOptions} onChange={value => { onChangeHost({ ...host, jumpHostId: value === '' ? null : value }) }} />{fieldInvalid('jumpHost') && <small className={css.fieldError}>{t('wizard.error.jumpHost')}</small>}</label>
          <label>{t('field.keepaliveSeconds')}<input type="number" min={0} value={host.keepAliveSeconds} onChange={event => { onChangeHost({ ...host, keepAliveSeconds: Number(event.target.value) }) }} /></label>
          <label className={css.full}>{t('field.knownHostFingerprint')}<div className={css.inputRow}><input value={host.knownHostFingerprint ?? ''} placeholder={t('field.fingerprintPlaceholder')} onChange={event => { onChangeHost({ ...host, knownHostFingerprint: event.target.value.trim() === '' ? null : event.target.value }) }} /><button type="button" disabled={probing || !canTestHost(host)} onClick={onProbe}>{probing ? t('wizard.probing') : t('wizard.probe')}</button></div><small className={css.fieldHint}>{t('wizard.fingerprintHint')}</small></label>
          <label className={css.full}>{t('field.defaultDirectory')}<input value={host.defaultDirectory ?? ''} placeholder={t('wizard.placeholder.directory')} onChange={event => { onChangeHost({ ...host, defaultDirectory: event.target.value }) }} /><small className={css.fieldHint}>{t('wizard.directoryHint')}</small></label>
          <label className={css.full}>{t('field.description')}<textarea value={host.description} onChange={event => { onChangeHost({ ...host, description: event.target.value }) }} /></label>
        </div>}
      </div>

      <footer className={css.wizardFooter}>
        <div className={css.testArea}>
          <button type="button" className={css.testButton} disabled={!canTestHost(host) || busy} onClick={onTest}><VscPulse />{t('wizard.testConnection')}</button>
          {testTag !== null && <div className={css.testResult}>
            <StatusTag tone={testTag.tone} label={testTag.label} detail={testTag.detail} />
            {testTag.tone === 'fail' && testTag.detail !== undefined && <small className={css.testReason}>{testTag.detail}</small>}
          </div>}
        </div>
        <div className={css.wizardNav}>
          <button type="button" onClick={onClose}>{t('action.cancel')}</button>
          {step > 0 && <button type="button" onClick={() => { setStep((step - 1) as WizardStep) }}><VscChevronLeft />{t('wizard.back')}</button>}
          {step < 2
            ? <button type="button" className={css.primary} onClick={next}>{t('wizard.next')}<VscChevronRight /></button>
            : <button type="button" className={css.primary} disabled={busy} onClick={save}><VscSave />{t('wizard.saveConnection')}</button>}
        </div>
      </footer>
    </div>
  </div>
}
