import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react'
import { Button, SettingsValueField, StateDot, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { en } from './locales.ts'
import { setWanxiangBrandEnabled, wanxiangBrandPreference } from './brand-store.ts'
import { fetchModelSyncStatus, postModelSyncAction } from './model-sync-client.ts'
import type { ModelSyncStatus } from './model-sync-client.ts'
import {
  WorkspaceLimitsRejection,
  fetchWorkspaceLimits,
  saveWorkspaceLimits,
} from './workspace-limits-client.ts'
import type { WorkspaceLimits, WorkspaceLimitsStatus } from './workspace-limits-client.ts'
import {
  TOOL_TIMEOUT_MAX_SECONDS,
  TOOL_TIMEOUT_MIN_SECONDS,
  fetchToolTimeout,
  saveToolTimeout,
} from './tool-timeout-client.ts'
import { ReviewSettingsCard } from './ReviewSettingsCard.tsx'
import styles from './ManagedDataOpsSection.module.css'

/** Values injected by the DSH Settings slot. */
export interface ManagedDataOpsSectionInjected {
  /** Translate one managed DataOps Settings message key. */
  t: (key: keyof typeof en) => string
}

/** Props accepted by the managed DataOps Settings section. */
export type ManagedDataOpsSectionProps = Partial<InjectFace<ManagedDataOpsSectionInjected>>

/** The panel's unit, so a stored byte count survives a round trip through the input. */
const BYTES_PER_MIB = 1024 * 1024

/** Render a byte ceiling as the whole MiB the input shows. */
function toMib(bytes: number): string {
  return String(Math.round((bytes / BYTES_PER_MIB) * 100) / 100)
}

/** Parse a MiB draft into a byte ceiling, or null when it is not a positive count. */
function toBytes(text: string): number | null {
  if (text.trim() === '') return null
  const mib = Number(text)
  if (!Number.isFinite(mib) || mib <= 0) return null
  const bytes = Math.round(mib * BYTES_PER_MIB)
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null
}

/** Format a stored publication time for the row, or nothing when it never published. */
function publishedText(publishedAt: string): string | null {
  const at = new Date(publishedAt)
  return Number.isNaN(at.getTime()) ? null : at.toLocaleString()
}

/**
 * The DataOps settings this workspace owns: its connection state, its branding, its file ceilings,
 * and the default configuration it publishes to other workspaces.
 * @param props - Settings slot injection values.
 * @returns The localized managed DataOps section, or nothing before injection.
 */
export function ManagedDataOpsSection(props: ManagedDataOpsSectionProps) {
  const { t } = props
  const branding = useSyncExternalStore(
    wanxiangBrandPreference.subscribe,
    wanxiangBrandPreference.getSnapshot,
    wanxiangBrandPreference.getSnapshot,
  )
  if (t === undefined) return null

  return (
    <section className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>
      <div className={styles.status}>
        <StateDot state="done" />
        <span>{t('managed')}</span>
      </div>
      <BrandingRow t={t} enabled={branding.enabled} />
      <LimitsCard t={t} />
      <TimeoutCard t={t} />
      <ReviewSettingsCard t={t} />
      <DefaultsCard t={t} />
    </section>
  )
}

/** The branding toggle as one settings row. */
function BrandingRow({ t, enabled }: { t: (key: keyof typeof en) => string; enabled: boolean }) {
  return (
    <div className={styles.card}>
      <div className={styles.row}>
        <span className={styles.label}>{t('brandingTitle')}</span>
        <Switch
          checked={enabled}
          label={t('brandingToggle')}
          onChange={(next) => { setWanxiangBrandEnabled(next) }}
        />
      </div>
    </div>
  )
}

/** What either card knows about its remote document. */
type LoadState<T> =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; status: T }
  | { kind: 'failed' }

/** The one row a card renders while it cannot offer its controls. */
function UnavailableCard({ title, t, state }: {
  title: string
  t: (key: keyof typeof en) => string
  state: 'unavailable' | 'failed'
}) {
  return (
    <section className={styles.card}>
      <h3 className={styles.heading}>{title}</h3>
      <div className={styles.status} role={state === 'failed' ? 'alert' : undefined}>
        <StateDot state={state === 'failed' ? 'error' : 'idle'} />
        <span>{state === 'failed' ? t('loadFailed') : t('unavailable')}</span>
      </div>
    </section>
  )
}

/**
 * The file ceilings DataOps enforces on this workspace.
 *
 * The values live in DataOps and are read through the plugin, which holds the JWT; the panel only
 * ever holds what the administrator is allowed to see.
 * @param props - Translate function from the section.
 * @returns The limits card.
 */
function LimitsCard({ t }: { t: (key: keyof typeof en) => string }) {
  const [state, setState] = useState<LoadState<WorkspaceLimitsStatus>>({ kind: 'loading' })
  const [fileReadMib, setFileReadMib] = useState('')
  const [uploadMib, setUploadMib] = useState('')
  /** The ceilings the draft started from, so Save stays off until one of them changes. */
  const [saved, setSaved] = useState('')
  /** Why DataOps refused the last save, kept beside the draft it refused. */
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileReadId = useId()
  const uploadId = useId()

  const apply = useCallback((status: WorkspaceLimitsStatus) => {
    setState({ kind: 'ready', status })
    const file = toMib(status.limits.fileReadMaxBytes)
    const upload = toMib(status.limits.uploadMaxBytes)
    setFileReadMib(file)
    setUploadMib(upload)
    setSaved(file + '|' + upload)
    setRefusal(null)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const status = await fetchWorkspaceLimits()
      if (status === null) setState({ kind: 'unavailable' })
      else apply(status)
    } catch {
      setState({ kind: 'failed' })
    }
  }, [apply])

  useEffect(() => { void refresh() }, [refresh])

  const fileReadBytes = toBytes(fileReadMib)
  const uploadBytes = toBytes(uploadMib)
  const writable = state.kind === 'ready' && state.status.canWrite
  const dirty = fileReadMib + '|' + uploadMib !== saved
  const ready = fileReadBytes !== null && uploadBytes !== null && dirty

  /** Edit one ceiling, dropping a refusal that no longer describes what is in the field. */
  const edit = useCallback((set: (text: string) => void) => (text: string) => {
    set(text)
    setRefusal(null)
  }, [])

  const submit = useCallback(async () => {
    if (fileReadBytes === null || uploadBytes === null) return
    setBusy(true)
    setRefusal(null)
    try {
      const limits: WorkspaceLimits = { fileReadMaxBytes: fileReadBytes, uploadMaxBytes: uploadBytes }
      const status = await saveWorkspaceLimits(limits)
      if (status === null) setState({ kind: 'unavailable' })
      else apply(status)
    } catch (error) {
      // A refused value keeps the fields and the draft, so the user can correct it in place.
      // Anything else left the card unable to describe its own state, so it reports the read.
      if (error instanceof WorkspaceLimitsRejection) setRefusal(error.message)
      else setState({ kind: 'failed' })
    } finally {
      setBusy(false)
    }
  }, [fileReadBytes, uploadBytes, apply])

  if (state.kind === 'loading') return null
  if (state.kind !== 'ready') {
    return <UnavailableCard title={t('limitsTitle')} t={t} state={state.kind} />
  }

  const disabled = busy || !writable
  return (
    <section className={styles.card}>
      <h3 className={styles.heading}>{t('limitsTitle')}</h3>
      <div className={styles.fields}>
        <div>
          <SettingsValueField
            id={fileReadId}
            label={t('limitsFileReadLabel')}
            text={fileReadMib}
            numeric
            invalid={fileReadBytes === null}
            overridden={false}
            overriddenLabel=""
            resetLabel=""
            invalidLabel={t('limitsInvalid')}
            disabled={disabled}
            onEdit={edit(setFileReadMib)}
            onReset={() => undefined}
          />
        </div>
        <div>
          <SettingsValueField
            id={uploadId}
            label={t('limitsUploadLabel')}
            text={uploadMib}
            numeric
            invalid={uploadBytes === null}
            overridden={false}
            overriddenLabel=""
            resetLabel=""
            invalidLabel={t('limitsInvalid')}
            disabled={disabled}
            onEdit={edit(setUploadMib)}
            onReset={() => undefined}
          />
        </div>
      </div>
      <div className={styles.actions}>
        {refusal === null
          ? null
          : (
            <span className={styles.refusal} role="alert">
              <StateDot state="error" />
              <span>{refusal}</span>
            </span>
          )}
        <Button variant="primary" size="sm" disabled={disabled || !ready} onClick={() => { void submit() }}>
          {busy ? t('limitsSaving') : t('limitsSave')}
        </Button>
      </div>
    </section>
  )
}

/**
 * How long one tool call may run before it is abandoned.
 *
 * The value lives in this plugin's own configuration, so it is per workspace and survives a
 * restart. It is edited in seconds because that is the unit an operator reasons in; the plugin
 * stores milliseconds and converts on the way through.
 * @param props - Translate function from the section.
 * @returns The tool-call timeout card.
 */
function TimeoutCard({ t }: { t: (key: keyof typeof en) => string }) {
  const [state, setState] = useState<LoadState<number>>({ kind: 'loading' })
  const [seconds, setSeconds] = useState('')
  /** The value the draft started from, so Save stays off until it changes. */
  const [saved, setSaved] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = useId()

  const apply = useCallback((milliseconds: number) => {
    setState({ kind: 'ready', status: milliseconds })
    const text = String(Math.round(milliseconds / 1000))
    setSeconds(text)
    setSaved(text)
    setRefusal(null)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const status = await fetchToolTimeout()
      if (status === null) setState({ kind: 'unavailable' })
      else apply(status.toolCallTimeoutMs)
    } catch {
      setState({ kind: 'failed' })
    }
  }, [apply])

  useEffect(() => { void refresh() }, [refresh])

  const parsed = Number(seconds)
  const valid = seconds.trim() !== '' && Number.isFinite(parsed)
    && parsed >= TOOL_TIMEOUT_MIN_SECONDS && parsed <= TOOL_TIMEOUT_MAX_SECONDS
  const dirty = seconds !== saved
  const disabled = busy

  const submit = useCallback(async () => {
    if (!valid) return
    setBusy(true)
    setRefusal(null)
    try {
      const status = await saveToolTimeout(Math.round(parsed * 1000))
      if (status === null) setState({ kind: 'unavailable' })
      else apply(status.toolCallTimeoutMs)
    } catch (error) {
      // A refused value keeps the field and the draft, so the user can correct it in place.
      if (error instanceof Error) setRefusal(error.message)
      else setState({ kind: 'failed' })
    } finally {
      setBusy(false)
    }
  }, [valid, parsed, apply])

  if (state.kind === 'loading') return null
  if (state.kind !== 'ready') {
    return <UnavailableCard title={t('timeoutTitle')} t={t} state={state.kind} />
  }

  return (
    <section className={styles.card}>
      <h3 className={styles.heading}>{t('timeoutTitle')}</h3>
      <div className={styles.fields}>
        <div>
          <SettingsValueField
            id={id}
            label={t('timeoutLabel')}
            text={seconds}
            numeric
            invalid={!valid}
            overridden={false}
            overriddenLabel=""
            resetLabel=""
            invalidLabel={t('timeoutInvalid')}
            disabled={disabled}
            onEdit={(text) => { setSeconds(text); setRefusal(null) }}
            onReset={() => undefined}
          />
        </div>
      </div>
      <div className={styles.actions}>
        {refusal === null
          ? null
          : (
            <span className={styles.refusal} role="alert">
              <StateDot state="error" />
              <span>{refusal}</span>
            </span>
          )}
        <Button
          variant="primary"
          size="sm"
          disabled={disabled || !valid || !dirty}
          onClick={() => { void submit() }}
        >
          {busy ? t('limitsSaving') : t('limitsSave')}
        </Button>
      </div>
    </section>
  )
}

/**
 * Publish this workspace's configuration as the default other users start from.

 * One action rather than a set of controls: the configuration is whatever this workspace already
 * holds, and the button copies it to DataOps.
 * @param props - Translate function from the section.
 * @returns The default-configuration card.
 */
function DefaultsCard({ t }: { t: (key: keyof typeof en) => string }) {
  const [state, setState] = useState<LoadState<ModelSyncStatus>>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const status = await fetchModelSyncStatus()
      setState(status === null ? { kind: 'unavailable' } : { kind: 'ready', status })
    } catch {
      setState({ kind: 'failed' })
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const publish = useCallback(async () => {
    setBusy(true)
    try {
      const status = await postModelSyncAction({ action: 'publish-defaults' })
      if (status === null) setState({ kind: 'unavailable' })
      else setState({ kind: 'ready', status })
    } catch {
      setState({ kind: 'failed' })
    } finally {
      setBusy(false)
    }
  }, [])

  if (state.kind === 'loading') return null
  if (state.kind !== 'ready') {
    return <UnavailableCard title={t('defaultsTitle')} t={t} state={state.kind} />
  }

  const published = state.status.publishedAt === null
    ? null
    : publishedText(state.status.publishedAt)

  // A viewer DataOps does not authorize to publish sees the state without the action, because the
  // permission rule lives in DataOps and the browser must not restate it.
  return (
    <section className={styles.card}>
      <div className={styles.row}>
        <div className={styles.copy}>
          <span className={styles.label}>{t('defaultsTitle')}</span>
          <span className={styles.meta}>
            {published === null
              ? t('defaultsNeverPublished')
              : t('defaultsPublishedAt') + ' · ' + published}
          </span>
        </div>
        {state.status.canPublish
          ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { void publish() }}>
              {busy ? t('defaultsPublishing') : t('defaultsPublish')}
            </Button>
          )
          : <span className={styles.meta}>{t('defaultsNotAdmin')}</span>}
      </div>
    </section>
  )
}
