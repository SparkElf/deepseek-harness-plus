// @ts-nocheck
import { useMemo, useState } from 'react'
import { driverCapabilities } from '../dialects.ts'
import type { ConnectionConfig, ConnectionKind } from '../types.ts'
import { useT } from './i18n.tsx'
import css from './SqlWorkbench.module.css'

interface ConnectionForm {
  id: string
  name: string
  kind: ConnectionKind
  description: string
  tags: string
  versionHint: string
  file: string
  host: string
  port: number
  user: string
  password: string
  database: string
  serviceName: string
}

type FormErrors = Partial<Record<'name' | 'file' | 'host' | 'port' | 'user' | 'database', string>>
type TestState = { kind: 'testing' | 'ok' | 'error'; text: string }

function formOf(connection: ConnectionConfig | null): ConnectionForm {
  if (connection === null) {
    return { id: '', name: '', kind: 'sqlite', description: '', tags: '', versionHint: '', file: '', host: '127.0.0.1', port: 0, user: '', password: '', database: '', serviceName: '' }
  }
  const metadata = {
    description: connection.description ?? '',
    tags: connection.tags?.join(', ') ?? '',
    versionHint: connection.versionHint ?? '',
  }
  if (connection.kind === 'sqlite') {
    return { id: connection.id, name: connection.name, kind: connection.kind, ...metadata, file: connection.file, host: '', port: 0, user: '', password: '', database: '', serviceName: '' }
  }
  return {
    id: connection.id,
    name: connection.name,
    kind: connection.kind,
    ...metadata,
    file: '',
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password ?? '',
    database: connection.database,
    serviceName: connection.kind === 'oracle' ? connection.serviceName : '',
  }
}

function metadataOf(form: ConnectionForm) {
  const tags = form.tags.split(',').map(tag => tag.trim()).filter(Boolean)
  return {
    ...(form.description.trim() === '' ? {} : { description: form.description.trim() }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(form.versionHint.trim() === '' ? {} : { versionHint: form.versionHint.trim() }),
  }
}

function connectionOf(form: ConnectionForm): ConnectionConfig {
  const metadata = metadataOf(form)
  if (form.kind === 'sqlite') return { id: form.id, name: form.name, kind: form.kind, file: form.file, ...metadata }
  const network = { id: form.id, name: form.name, host: form.host, port: form.port, user: form.user, password: form.password, database: form.database, ...metadata }
  if (form.kind === 'oracle') return { ...network, kind: form.kind, serviceName: form.serviceName }
  return { ...network, kind: form.kind }
}

export interface ConnectionDialogProps {
  connection: ConnectionConfig | null
  onClose(): void
  onSave(connection: ConnectionConfig): Promise<void>
  onTest(connection: ConnectionConfig): Promise<{ durationMs?: number } | void>
}

/**
 * The database connection editor.
 *
 * The type list is grouped by what the form then asks for instead of being one flat
 * dropdown: a file database and a server database are different forms, and pressing
 * Test must answer with latency or the driver's message right beside the fields.
 */
export function ConnectionDialog({ connection, onClose, onSave, onTest }: ConnectionDialogProps) {
  const t = useT()
  const [form, setForm] = useState(() => formOf(connection))
  const [test, setTest] = useState<TestState | null>(null)
  const [saving, setSaving] = useState(false)
  const patch = (value: Partial<ConnectionForm>): void => { setForm(current => ({ ...current, ...value })); setTest(null) }

  const errors = useMemo<FormErrors>(() => {
    const next: FormErrors = {}
    if (form.name.trim() === '') next.name = t('connection.required.name')
    if (form.kind === 'sqlite') {
      if (form.file.trim() === '') next.file = t('connection.required.file')
    } else {
      if (form.host.trim() === '') next.host = t('connection.required.host')
      if (!Number.isInteger(form.port) || form.port < 1 || form.port > 65535) next.port = t('connection.invalid.port')
      if (form.user.trim() === '') next.user = t('connection.required.user')
      if (form.database.trim() === '') next.database = t('connection.required.database')
    }
    return next
  }, [form, t])

  const connectionErrors = useMemo<FormErrors>(() => {
    const { name: _name, ...rest } = errors
    return rest
  }, [errors])
  const canSave = Object.keys(errors).length === 0 && !saving
  const canTest = Object.keys(connectionErrors).length === 0

  const runTest = async (): Promise<void> => {
    if (!canTest) return
    setTest({ kind: 'testing', text: t('status.testing') })
    try {
      const result = await onTest(connectionOf(form))
      const elapsed = result?.durationMs
      setTest({
        kind: 'ok',
        text: typeof elapsed === 'number' ? t('connection.testOk', { ms: elapsed }) : t('status.connected'),
      })
    } catch (failure) {
      console.error('[dsh-sql-workbench] connection test failed', failure)
      setTest({ kind: 'error', text: t('connection.testFailed') + ': ' + (failure instanceof Error ? failure.message : String(failure)) })
    }
  }

  const runSave = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    try {
      await onSave(connectionOf(form))
      onClose()
    } catch (failure) {
      console.error('[dsh-sql-workbench] connection save failed', failure)
      setTest({ kind: 'error', text: failure instanceof Error ? failure.message : String(failure) })
    } finally {
      setSaving(false)
    }
  }

  return <div className={css.dialogBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className={css.dialog} role="dialog" aria-label={t('dialog.connection')}>
      <div className={css.dialogTitle}>{connection === null ? t('dialog.connection.new') : t('dialog.connection.edit')}</div>
      <label className={css.field}><span>{t('field.name')}</span><input value={form.name} aria-invalid={errors.name !== undefined} onChange={event => { patch({ name: event.target.value }) }} />
        {errors.name !== undefined && <span className={css.fieldError}>{errors.name}</span>}</label>
      <label className={css.field}><span>{t('field.type')}</span><select value={form.kind} onChange={event => {
        const kind = event.target.value as ConnectionKind
        patch({ kind, port: driverCapabilities(kind).defaultPort ?? 0 })
      }}>
        <optgroup label={t('connection.group.file')}>
          <option value="sqlite">SQLite</option>
        </optgroup>
        <optgroup label={t('connection.group.server')}>
          <option value="mysql">MySQL</option>
          <option value="mariadb">MariaDB</option>
          <option value="postgres">PostgreSQL</option>
        </optgroup>
        <optgroup label={t('connection.group.other')}>
          <option value="doris">Apache Doris</option>
          <option value="oracle">Oracle</option>
        </optgroup>
      </select></label>
      {form.kind === 'sqlite'
        ? <label className={css.field}><span>{t('field.file')}</span><input value={form.file} aria-invalid={errors.file !== undefined} onChange={event => { patch({ file: event.target.value }) }} />
          {errors.file !== undefined && <span className={css.fieldError}>{errors.file}</span>}</label>
        : <>
          <div className={css.fieldRow}>
            <label className={css.field}><span>{t('field.host')}</span><input value={form.host} aria-invalid={errors.host !== undefined} onChange={event => { patch({ host: event.target.value }) }} />
              {errors.host !== undefined && <span className={css.fieldError}>{errors.host}</span>}</label>
            <label className={css.fieldSmall}><span>{t('field.port')}</span><input type="number" value={form.port} aria-invalid={errors.port !== undefined} onChange={event => { patch({ port: Number(event.target.value) }) }} />
              {errors.port !== undefined && <span className={css.fieldError}>{errors.port}</span>}</label>
          </div>
          {form.kind === 'oracle' && <label className={css.field}><span>{t('field.serviceName')}</span><input value={form.serviceName} onChange={event => { patch({ serviceName: event.target.value }) }} /></label>}
          <label className={css.field}><span>{t('field.database')}</span><input value={form.database} aria-invalid={errors.database !== undefined} onChange={event => { patch({ database: event.target.value }) }} />
            {errors.database !== undefined && <span className={css.fieldError}>{errors.database}</span>}</label>
          <label className={css.field}><span>{t('field.user')}</span><input value={form.user} aria-invalid={errors.user !== undefined} onChange={event => { patch({ user: event.target.value }) }} />
            {errors.user !== undefined && <span className={css.fieldError}>{errors.user}</span>}</label>
          <label className={css.field}><span>{t('field.password')}</span><input type="password" value={form.password} onChange={event => { patch({ password: event.target.value }) }} /></label>
        </>}
      <label className={css.field}><span>{t('field.description')}</span><input value={form.description} onChange={event => { patch({ description: event.target.value }) }} /></label>
      <label className={css.field}><span>{t('field.tags')}</span><input value={form.tags} placeholder={t('field.tags.placeholder')} onChange={event => { patch({ tags: event.target.value }) }} /></label>
      <label className={css.field}><span>{t('field.versionHint')}</span><input value={form.versionHint} onChange={event => { patch({ versionHint: event.target.value }) }} /></label>
      {test !== null && <div className={css.testTag} data-kind={test.kind} role="status">{test.text}</div>}
      <div className={css.dialogActions}>
        <button onClick={onClose}>{t('action.cancel')}</button>
        <button disabled={!canTest || test?.kind === 'testing'} onClick={() => { void runTest() }}>{t('action.test')}</button>
        <button className={css.primaryButton} disabled={!canSave} onClick={() => { void runSave() }}>{t('action.save')}</button>
      </div>
    </div>
  </div>
}
