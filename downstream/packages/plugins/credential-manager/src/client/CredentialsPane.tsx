import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  VscAdd, VscArrowLeft, VscCheck, VscCircleFilled, VscClose, VscCloud, VscDatabase,
  VscDebugAlt, VscEdit, VscGlobe, VscKey, VscLock, VscRefresh, VscSearch, VscServer,
  VscSettingsGear, VscShield, VscTerminal, VscTrash, VscWarning,
} from 'react-icons/vsc'
import { CREDENTIAL_TEMPLATES, defaultAuthKind, defaultConfigFor, describeEndpoint, templateFor } from '../templates.ts'
import type {
  CredentialConfig, CredentialConfigValue, CredentialDraft, CredentialSecretInput,
  CredentialSummary, CredentialTemplate, CredentialTestResult, CredentialType,
} from '../types.ts'
import { deleteCredential, loadState, saveCredential, testCredential, toggleCredential } from './api.ts'
import { useT, type Translate } from './i18n.tsx'
import { authLabel, configValueLabel, filterCredentials, initialDraft, nonEmptySecrets, parseTags, timeLabel, type PaneView } from './model.ts'
import styles from './CredentialsPane.module.css'

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function TypeIcon({ type }: { type: CredentialType }) {
  switch (type) {
    case 'prefect': return <VscCloud aria-hidden />
    case 'dataops': return <VscKey aria-hidden />
    case 'database': return <VscDatabase aria-hidden />
    case 'http': return <VscGlobe aria-hidden />
    case 'ssh': return <VscTerminal aria-hidden />
    case 'custom': return <VscSettingsGear aria-hidden />
  }
}

function Banner({ tone, children, onClose }: { tone: 'error' | 'success' | 'info'; children: React.ReactNode; onClose?: () => void }) {
  return (
    <div className={styles.banner + ' ' + styles['banner_' + tone]} role={tone === 'error' ? 'alert' : 'status'}>
      <span className={styles.bannerIcon}>
        {tone === 'success' ? <VscCheck aria-hidden /> : tone === 'error' ? <VscWarning aria-hidden /> : <VscShield aria-hidden />}
      </span>
      <span className={styles.bannerText}>{children}</span>
      {onClose === undefined ? null : (
        <button type="button" className={styles.bannerClose} onClick={onClose} aria-label="Close">
          <VscClose aria-hidden />
        </button>
      )}
    </div>
  )
}

function SecretStatus({ meta, t }: { meta: CredentialSummary; t: Translate }) {
  if (meta.secretRef !== null) return <span className={styles.secretRef}>{t('list.secretRef', { ref: meta.secretRef })}</span>
  const method = templateFor(meta.type).authMethods.find(item => item.value === meta.authKind)
  if (method !== undefined && method.requiredSecrets.length === 0) {
    return <span className={styles.secretNeutral}>{t('list.secretNotRequired')}</span>
  }
  return meta.secretConfigured
    ? <span className={styles.secretReady}><VscCheck aria-hidden /> {t('list.secretReady')}</span>
    : <span className={styles.secretMissing}><VscWarning aria-hidden /> {t('list.secretMissing')}</span>
}

export function CredentialsPane({ visible }: { visible: boolean }) {
  const t = useT()
  const [credentials, setCredentials] = useState<CredentialSummary[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<CredentialType | 'all'>('all')
  const [view, setView] = useState<PaneView>({ kind: 'list' })
  const [busy, setBusy] = useState<{ id: string; action: 'test' | 'toggle' } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CredentialSummary | null>(null)
  const [deleting, setDeleting] = useState(false)

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const next = await loadState()
      setCredentials(next.credentials)
      setError(null)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (visible) void refresh() }, [visible, refresh])
  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => setNotice(null), 4500)
    return () => window.clearTimeout(timer)
  }, [notice])

  const filtered = useMemo(() => filterCredentials(credentials ?? [], query, typeFilter), [credentials, query, typeFilter])
  const selected = view.kind === 'detail' ? credentials?.find(meta => meta.id === view.id) : undefined
  const editing = view.kind === 'form' && view.id !== undefined ? credentials?.find(meta => meta.id === view.id) : undefined

  const runTest = async (meta: CredentialSummary) => {
    setBusy({ id: meta.id, action: 'test' })
    try {
      const result = await testCredential(meta.id)
      setNotice(result.ok ? t('notice.testedOk') : t('notice.testedFail'))
      await refresh(true)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const runToggle = async (meta: CredentialSummary) => {
    setBusy({ id: meta.id, action: 'toggle' })
    try {
      await toggleCredential(meta.id, !meta.enabled)
      setNotice(t('notice.toggled'))
      await refresh(true)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const confirmDelete = async () => {
    if (deleteTarget === null) return
    setDeleting(true)
    try {
      await deleteCredential(deleteTarget.id, deleteTarget.name)
      setDeleteTarget(null)
      setNotice(t('notice.deleted'))
      setView({ kind: 'list' })
      await refresh(true)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setDeleting(false)
    }
  }

  const backToList = () => setView({ kind: 'list' })

  return (
    <section className={styles.pane} aria-label={t('app.title')}>
      <header className={styles.header}>
        {view.kind === 'list' ? (
          <div className={styles.titleRow}>
            <div className={styles.titleBlock}>
              <h1 className={styles.title}><VscLock aria-hidden /> {t('app.title')}</h1>
              <p className={styles.subtitle}>{t('app.subtitle')}</p>
            </div>
            <button type="button" className={styles.iconButton} onClick={() => void refresh()} title={t('app.refresh')} aria-label={t('app.refresh')} disabled={loading}>
              <VscRefresh aria-hidden />
            </button>
          </div>
        ) : (
          <div className={styles.titleRow}>
            <button type="button" className={styles.backButton} onClick={backToList}>
              <VscArrowLeft aria-hidden /> {t('action.back')}
            </button>
            <span className={styles.headerContext}>{view.kind === 'detail' ? selected?.name ?? '' : editing === undefined ? t('form.createTitle') : t('form.editTitle')}</span>
          </div>
        )}

        {view.kind === 'list' ? (
          <div className={styles.toolbar}>
            <label className={styles.searchBox}>
              <VscSearch aria-hidden />
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('search.placeholder')} aria-label={t('search.placeholder')} />
            </label>
            <select className={styles.select} value={typeFilter} onChange={event => setTypeFilter(event.target.value as CredentialType | 'all')} aria-label={t('filter.label')}>
              <option value="all">{t('filter.allTypes')}</option>
              {CREDENTIAL_TEMPLATES.map(template => <option key={template.type} value={template.type}>{t(('type.' + template.type) as 'type.prefect')}</option>)}
            </select>
            <button type="button" className={styles.primaryButton} onClick={() => setView({ kind: 'form' })}>
              <VscAdd aria-hidden /> {t('action.create')}
            </button>
          </div>
        ) : null}
      </header>

      {error === null ? null : <Banner tone="error" onClose={() => setError(null)}>{error}</Banner>}
      {notice === null ? null : <Banner tone="success" onClose={() => setNotice(null)}>{notice}</Banner>}

      <div className={styles.content}>
        {view.kind === 'list' ? (
          loading && credentials === null ? (
            <p className={styles.loading}>{t('common.loading')}</p>
          ) : credentials !== null && credentials.length === 0 ? (
            <div className={styles.empty}>
              <VscLock aria-hidden className={styles.emptyIcon} />
              <h2>{t('list.empty.title')}</h2>
              <p>{t('list.empty.description')}</p>
              <button type="button" className={styles.primaryButton} onClick={() => setView({ kind: 'form' })}>
                <VscAdd aria-hidden /> {t('action.create')}
              </button>
            </div>
          ) : (
            <>
              <div className={styles.listMeta}>{t('list.count', { count: filtered.length })}</div>
              {filtered.length === 0 ? <p className={styles.emptyFiltered}>{t('list.empty.filtered')}</p> : (
                <div className={styles.list}>
                  {filtered.map(meta => {
                    const template = templateFor(meta.type)
                    const endpoint = describeEndpoint(meta)
                    const isBusy = busy?.id === meta.id
                    return (
                      <article key={meta.id} className={styles.card + (meta.enabled ? '' : ' ' + styles.cardDisabled)}>
                        <button type="button" className={styles.cardMain} onClick={() => setView({ kind: 'detail', id: meta.id })}>
                          <span className={styles.cardIcon + ' ' + (styles['type_' + meta.type] ?? '')}><TypeIcon type={meta.type} /></span>
                          <span className={styles.cardBody}>
                            <span className={styles.cardTitleRow}>
                              <span className={styles.cardName}>{meta.name}</span>
                              <span className={styles.typeBadge}>{t(('type.' + meta.type) as 'type.prefect')}</span>
                              {meta.enabled ? null : <span className={styles.disabledBadge}>{t('list.disabled')}</span>}
                            </span>
                            <span className={styles.cardEndpoint}>{endpoint === '' ? meta.description || t('list.noEndpoint') : endpoint}</span>
                            <span className={styles.cardStatus}>
                              <SecretStatus meta={meta} t={t} />
                              {meta.lastTest === null ? null : (
                                <span className={meta.lastTest.ok ? styles.testPass : styles.testFail}>
                                  {meta.lastTest.ok ? t('test.ok') : t('test.failed')}
                                </span>
                              )}
                            </span>
                            {meta.tags.length === 0 ? null : (
                              <span className={styles.tagRow}>{meta.tags.map(tag => <span key={tag} className={styles.tag}>{tag}</span>)}</span>
                            )}
                          </span>
                        </button>
                        <div className={styles.cardActions}>
                          <button type="button" className={styles.ghostButton} onClick={() => void runTest(meta)} disabled={isBusy}>
                            <VscDebugAlt aria-hidden /> {isBusy && busy?.action === 'test' ? t('action.testing') : t('action.test')}
                          </button>
                          <button type="button" className={styles.ghostButton} onClick={() => void runToggle(meta)} disabled={isBusy}>
                            <VscCircleFilled aria-hidden /> {meta.enabled ? t('action.disable') : t('action.enable')}
                          </button>
                          <button type="button" className={styles.ghostButton} onClick={() => setView({ kind: 'form', id: meta.id })}>
                            <VscEdit aria-hidden /> {t('action.edit')}
                          </button>
                          <button type="button" className={styles.ghostDanger} onClick={() => setDeleteTarget(meta)}>
                            <VscTrash aria-hidden /> {t('action.delete')}
                          </button>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </>
          )
        ) : view.kind === 'detail' ? (
          selected === undefined ? (
            <div className={styles.empty}>
              <p>{t('list.empty.filtered')}</p>
              <button type="button" className={styles.primaryButton} onClick={backToList}>{t('action.back')}</button>
            </div>
          ) : (
            <CredentialDetail
              meta={selected}
              busy={busy?.id === selected.id}
              onEdit={() => setView({ kind: 'form', id: selected.id })}
              onTest={() => void runTest(selected)}
              onToggle={() => void runToggle(selected)}
              onDelete={() => setDeleteTarget(selected)}
            />
          )
        ) : (
          <CredentialForm
            key={view.id ?? 'new'}
            existing={editing}
            onCancel={backToList}
            onSaved={meta => {
              setCredentials(current => {
                const list = current ?? []
                const index = list.findIndex(item => item.id === meta.id)
                if (index === -1) return [...list, meta]
                const next = [...list]
                next[index] = meta
                return next
              })
              setNotice(t('notice.saved'))
              setView({ kind: 'detail', id: meta.id })
              void refresh(true)
            }}
          />
        )}
      </div>

      {deleteTarget === null ? null : (
        <DeleteDialog
          meta={deleteTarget}
          busy={deleting}
          onCancel={() => { if (!deleting) setDeleteTarget(null) }}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </section>
  )
}

function CredentialDetail({ meta, busy, onEdit, onTest, onToggle, onDelete }: {
  meta: CredentialSummary
  busy: boolean
  onEdit: () => void
  onTest: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  const t = useT()
  const template = templateFor(meta.type)
  const method = template.authMethods.find(item => item.value === meta.authKind) ?? template.authMethods[0]
  const secretFields = template.secretFields.filter(field => method?.secretFields.includes(field.key) ?? false)
  return (
    <div className={styles.detail}>
      <div className={styles.detailTitleRow}>
        <span className={styles.cardIcon + ' ' + (styles['type_' + meta.type] ?? '')}><TypeIcon type={meta.type} /></span>
        <div className={styles.detailTitleBlock}>
          <h2 className={styles.detailName}>{meta.name}</h2>
          <div className={styles.detailBadges}>
            <span className={styles.typeBadge}>{t(('type.' + meta.type) as 'type.prefect')}</span>
            <span className={meta.enabled ? styles.enabledBadge : styles.disabledBadge}>{meta.enabled ? t('list.enabled') : t('list.disabled')}</span>
          </div>
        </div>
      </div>

      {meta.enabled ? null : <Banner tone="info">{t('detail.disabledNote')}</Banner>}

      <div className={styles.detailActions}>
        <button type="button" className={styles.primaryButton} onClick={onEdit}><VscEdit aria-hidden /> {t('action.edit')}</button>
        <button type="button" className={styles.ghostButton} onClick={onTest} disabled={busy}><VscDebugAlt aria-hidden /> {busy ? t('action.testing') : t('action.test')}</button>
        <button type="button" className={styles.ghostButton} onClick={onToggle} disabled={busy}><VscCircleFilled aria-hidden /> {meta.enabled ? t('action.disable') : t('action.enable')}</button>
        <button type="button" className={styles.ghostDanger} onClick={onDelete}><VscTrash aria-hidden /> {t('action.delete')}</button>
      </div>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{t('detail.overview')}</h3>
        <dl className={styles.kv}>
          <dt>{t('detail.endpoint')}</dt><dd>{describeEndpoint(meta) || t('common.none')}</dd>
          <dt>{t('detail.authKind')}</dt><dd>{authLabel(meta.type, meta.authKind)}</dd>
          <dt>{t('detail.secretStatus')}</dt><dd>{meta.secretRef === null ? (meta.secretConfigured ? t('detail.configured') : t('detail.notConfigured')) : t('list.secretRef', { ref: meta.secretRef })}</dd>
          <dt>{t('detail.createdAt')}</dt><dd>{timeLabel(meta.createdAt)}</dd>
          <dt>{t('detail.updatedAt')}</dt><dd>{timeLabel(meta.updatedAt)}</dd>
          <dt>{t('detail.lastTestedAt')}</dt><dd>{meta.lastTestedAt === null ? t('detail.neverTested') : timeLabel(meta.lastTestedAt)}</dd>
        </dl>
        {meta.description === '' ? null : <p className={styles.description}>{meta.description}</p>}
        <div className={styles.tagRow}>{meta.tags.length === 0 ? <span className={styles.muted}>{t('detail.noTags')}</span> : meta.tags.map(tag => <span key={tag} className={styles.tag}>{tag}</span>)}</div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{t('detail.config')}</h3>
        {template.configFields.length === 0 ? <p className={styles.muted}>{t('detail.noConfig')}</p> : (
          <dl className={styles.kv}>
            {template.configFields.map(field => (
              <ConfigRow key={field.key} label={field.label} value={meta.config[field.key]} />
            ))}
          </dl>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{t('detail.secrets')}</h3>
        <p className={styles.hint}>{t('detail.secretNote')}</p>
        {meta.secretRef === null ? (
          secretFields.length === 0 ? <p className={styles.muted}>{t('detail.secretNotRequired')}</p> : (
            <ul className={styles.secretList}>
              {secretFields.map(field => {
                const configured = meta.configuredSecretFields.includes(field.key)
                return (
                  <li key={field.key} className={styles.secretRow}>
                    <span>{field.label}</span>
                    <span className={configured ? styles.secretReady : styles.secretMissing}>
                      {configured ? <VscCheck aria-hidden /> : <VscWarning aria-hidden />}
                      {configured ? t('detail.configured') : t('detail.notConfigured')}
                    </span>
                  </li>
                )
              })}
            </ul>
          )
        ) : <p className={styles.secretRef}>{t('list.secretRef', { ref: meta.secretRef })}</p>}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{t('detail.tests')}</h3>
        <p className={styles.hint}>{t('detail.testHint')}</p>
        {meta.lastTest === null ? <p className={styles.muted}>{t('detail.neverTested')}</p> : <TestResult result={meta.lastTest} />}
      </section>
    </div>
  )
}

function ConfigRow({ label, value }: { label: string; value: CredentialConfigValue | undefined }) {
  return <><dt>{label}</dt><dd>{configValueLabel(value)}</dd></>
}

function TestResult({ result }: { result: CredentialTestResult }) {
  const t = useT()
  return (
    <div className={styles.testResult}>
      <div className={styles.testSummary + ' ' + (result.ok ? styles.testSummaryOk : styles.testSummaryFail)}>
        {result.ok ? <VscCheck aria-hidden /> : <VscWarning aria-hidden />}
        <strong>{result.ok ? t('test.ok') : t('test.failed')}</strong>
        <span>{t('test.checkedAt', { time: new Date(result.checkedAt).toLocaleString() })}</span>
      </div>
      <ul className={styles.checkList}>
        {result.checks.map(check => (
          <li key={check.id} className={styles.checkRow}>
            <span className={check.ok ? styles.checkPass : styles.checkFail}>{check.ok ? <VscCheck aria-hidden /> : <VscWarning aria-hidden />}</span>
            <span className={styles.checkLabel}>{check.label}</span>
            <span className={styles.checkDetail}>{check.detail}</span>
          </li>
        ))}
      </ul>
      <p className={styles.hint}>{t('test.localOnly')}</p>
    </div>
  )
}

function CredentialForm({ existing, onCancel, onSaved }: {
  existing: CredentialSummary | undefined
  onCancel: () => void
  onSaved: (meta: CredentialSummary) => void
}) {
  const t = useT()
  const [draft, setDraft] = useState<CredentialDraft>(() => initialDraft(existing))
  const [tagsText, setTagsText] = useState(existing?.tags.join(', ') ?? '')
  const [secretRefText, setSecretRefText] = useState(existing?.secretRef ?? '')
  const [secret, setSecret] = useState<CredentialSecretInput>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const template = templateFor(draft.type)
  const method = template.authMethods.find(item => item.value === draft.authKind) ?? template.authMethods[0]
  if (method === undefined) return null
  const config: CredentialConfig = draft.config ?? defaultConfigFor(draft.type)
  const secretFields = template.secretFields.filter(field => method.secretFields.includes(field.key))

  const changeType = (type: CredentialType) => {
    setDraft(current => ({ ...current, type, authKind: defaultAuthKind(type), config: defaultConfigFor(type) }))
    setSecret({})
  }

  const changeAuthKind = (authKind: string) => {
    const next = template.authMethods.find(item => item.value === authKind)
    setDraft(current => ({ ...current, authKind }))
    if (next !== undefined) {
      setSecret(current => Object.fromEntries(Object.entries(current).filter(([key]) => next.secretFields.includes(key))))
    }
  }

  const updateConfig = (key: string, value: CredentialConfigValue) => {
    setDraft(current => ({ ...current, config: { ...(current.config ?? defaultConfigFor(current.type)), [key]: value } }))
  }

  const missingConfig = template.configFields.filter(field => field.required && (config[field.key] === undefined || config[field.key] === null || config[field.key] === ''))
  const missingSecrets = method.requiredSecrets.filter(key => {
    if (existing?.configuredSecretFields.includes(key)) return false
    if ((secret[key] ?? '') !== '') return false
    if (secretRefText.trim() !== '') return false
    return true
  })
  const authConfigMissing = (draft.type === 'http' || draft.type === 'prefect') && method.value === 'basic' && String(config.username ?? '') === ''
    ? 'username'
    : draft.type === 'http' && method.value === 'header' && String(config.headerName ?? '') === '' ? 'headerName' : null
  const secretConflict = Object.values(secret).some(value => value !== '') && secretRefText.trim() !== ''
  const canSave = draft.name.trim() !== '' && missingConfig.length === 0 && missingSecrets.length === 0 && authConfigMissing === null && !secretConflict

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const saved = await saveCredential({
        ...draft,
        name: draft.name.trim(),
        description: (draft.description ?? '').trim(),
        tags: parseTags(tagsText),
        config,
        secretRef: secretRefText.trim() === '' ? null : secretRefText.trim(),
      }, nonEmptySecrets(secret))
      setSecret({})
      onSaved(saved)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className={styles.form} onSubmit={event => void submit(event)}>
      {error === null ? null : <Banner tone="error" onClose={() => setError(null)}>{error}</Banner>}

      <div className={styles.fieldGrid}>
        <label className={styles.field}>
          <span className={styles.label}>{t('form.name')}<span className={styles.required}>*</span></span>
          <input value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} placeholder={t('form.namePlaceholder')} autoFocus />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>{t('form.type')}</span>
          <select value={draft.type} onChange={event => changeType(event.target.value as CredentialType)} disabled={existing !== undefined}>
            {CREDENTIAL_TEMPLATES.map(item => <option key={item.type} value={item.type}>{t(('type.' + item.type) as 'type.prefect')}</option>)}
          </select>
          {existing === undefined ? null : <span className={styles.hint}>{t('form.typeImmutable')}</span>}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>{t('form.authKind')}</span>
          <select value={method.value} onChange={event => changeAuthKind(event.target.value)}>
            {template.authMethods.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>{t('form.description')}</span>
          <input value={draft.description ?? ''} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} placeholder={t('form.descriptionPlaceholder')} />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>{t('form.tags')}</span>
          <input value={tagsText} onChange={event => setTagsText(event.target.value)} placeholder={t('form.tagsPlaceholder')} />
        </label>

        <label className={styles.checkboxField}>
          <input type="checkbox" checked={draft.enabled ?? true} onChange={event => setDraft(current => ({ ...current, enabled: event.target.checked }))} />
          <span>{t('form.enabled')}</span>
        </label>
        <p className={styles.hint}>{t('form.enabledHint')}</p>
      </div>

      <section className={styles.formSection}>
        <h3 className={styles.sectionTitle}>{t('form.configSection')}</h3>
        <div className={styles.fieldGrid}>
          {template.configFields.map(field => (
            <label key={field.key} className={styles.field}>
              <span className={styles.label}>{field.label}{field.required ? <span className={styles.required}>*</span> : null}</span>
              {field.type === 'select' ? (
                <select value={String(config[field.key] ?? '')} onChange={event => updateConfig(field.key, event.target.value)}>
                  {(field.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              ) : field.type === 'boolean' ? (
                <input type="checkbox" checked={config[field.key] === true} onChange={event => updateConfig(field.key, event.target.checked)} />
              ) : (
                <input
                  type={field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text'}
                  value={config[field.key] === undefined || config[field.key] === null ? '' : String(config[field.key])}
                  onChange={event => {
                    if (field.type === 'number') {
                      const raw = event.target.value
                      updateConfig(field.key, raw === '' ? '' : Number(raw))
                    } else {
                      updateConfig(field.key, event.target.value)
                    }
                  }}
                  placeholder={field.placeholder}
                />
              )}
              {field.help === undefined ? null : <span className={styles.hint}>{field.help}</span>}
            </label>
          ))}
        </div>
      </section>

      <section className={styles.formSection}>
        <h3 className={styles.sectionTitle}>{t('form.secretSection')}</h3>
        <p className={styles.hint}>{t('form.secretHint')}</p>
        {secretFields.length === 0 ? <p className={styles.muted}>{t('form.noSecrets')}</p> : (
          <div className={styles.fieldGrid}>
            {secretFields.map(field => {
              const configured = existing?.configuredSecretFields.includes(field.key) ?? false
              return (
                <label key={field.key} className={styles.field}>
                  <span className={styles.label}>
                    {field.label}
                    {method.requiredSecrets.includes(field.key) ? <span className={styles.required}>*</span> : null}
                  </span>
                  {field.multiline ? (
                    <textarea
                      rows={4}
                      value={secret[field.key] ?? ''}
                      onChange={event => setSecret(current => ({ ...current, [field.key]: event.target.value }))}
                      placeholder={field.placeholder}
                      spellCheck={false}
                    />
                  ) : (
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={secret[field.key] ?? ''}
                      onChange={event => setSecret(current => ({ ...current, [field.key]: event.target.value }))}
                      placeholder={field.placeholder}
                    />
                  )}
                  {configured ? <span className={styles.hint}>{t('form.secretKeep')}</span> : null}
                </label>
              )
            })}
          </div>
        )}

        <label className={styles.field}>
          <span className={styles.label}>{t('form.secretRef')}</span>
          <input value={secretRefText} onChange={event => setSecretRefText(event.target.value)} placeholder={t('form.secretRefPlaceholder')} spellCheck={false} />
          <span className={styles.hint}>{t('form.secretRefHint')}</span>
        </label>
      </section>

      {canSave ? null : (
        <p className={styles.formHint}>
          {draft.name.trim() === '' ? t('form.error.name') : t('form.required')}
          {missingConfig.length > 0 ? ' · ' + missingConfig.map(field => field.label).join(', ') : ''}
          {missingSecrets.length > 0 ? ' · ' + missingSecrets.map(key => template.secretFields.find(field => field.key === key)?.label ?? key).join(', ') : ''}
          {authConfigMissing === null ? '' : ' · ' + authConfigMissing}
          {secretConflict ? ' · ' + t('form.secretConflict') : ''}
        </p>
      )}

      <div className={styles.formActions}>
        <button type="button" className={styles.ghostButton} onClick={onCancel} disabled={saving}>{t('action.cancel')}</button>
        <button type="submit" className={styles.primaryButton} disabled={!canSave || saving}>
          {saving ? t('action.saving') : t('action.save')}
        </button>
      </div>
    </form>
  )
}

function DeleteDialog({ meta, busy, onCancel, onConfirm }: {
  meta: CredentialSummary
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const t = useT()
  const [name, setName] = useState('')
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  const matches = name === meta.name
  return (
    <div className={styles.overlay} role="presentation">
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="credential-delete-title">
        <h2 id="credential-delete-title" className={styles.dialogTitle}><VscWarning aria-hidden /> {t('delete.title')}</h2>
        <p className={styles.dialogBody}>{t('delete.body', { name: meta.name })}</p>
        <label className={styles.field}>
          <span className={styles.label}>{t('delete.placeholder')}</span>
          <input value={name} onChange={event => setName(event.target.value)} autoFocus spellCheck={false} />
          <span className={matches ? styles.hint : styles.dialogError}>{matches ? t('delete.hint') : t('delete.mismatch')}</span>
        </label>
        <div className={styles.dialogActions}>
          <button type="button" className={styles.ghostButton} onClick={onCancel} disabled={busy}>{t('action.cancel')}</button>
          <button type="button" className={styles.dangerButton} onClick={onConfirm} disabled={!matches || busy}>
            {busy ? t('action.deleting') : t('action.confirmDelete')}
          </button>
        </div>
      </div>
    </div>
  )
}