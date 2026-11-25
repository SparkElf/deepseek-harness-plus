import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { en } from './locales.ts'
import { DEFAULT_REVIEW_SETTINGS, fetchReviewSettings, saveReviewSettings } from './review-client.ts'
import type { ReviewSettings } from './review-client.ts'
import styles from './ManagedDataOpsSection.module.css'

/**
 * The three plaza-review switches.
 *
 * The card is independent of the review queue so the settings page owns the switches while the
 * plaza owns the rows. Defaults are on; a 503 keeps the switches usable and says the API is
 * waiting rather than pretending the save happened.
 */
export function ReviewSettingsCard({ t }: { t: (key: keyof typeof en) => string }): ReactNode {
  const [settings, setSettings] = useState<ReviewSettings>(DEFAULT_REVIEW_SETTINGS)
  const [saved, setSaved] = useState<ReviewSettings>(DEFAULT_REVIEW_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void fetchReviewSettings().then((value) => {
      if (!live) return
      if (value === null) setUnavailable(true)
      else { setSettings(value); setSaved(value) }
    }).catch(() => { if (live) setUnavailable(true) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])

  const changed = settings.skillPlaza !== saved.skillPlaza
    || settings.workflowPlaza !== saved.workflowPlaza
    || settings.knowledgeBase !== saved.knowledgeBase

  const save = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const ok = await saveReviewSettings(settings)
      if (ok) {
        setSaved(settings)
        setMessage(t('reviewSettingsSaved'))
      } else {
        setMessage(t('reviewSettingsWaiting'))
      }
    } catch {
      setMessage(t('reviewSettingsFailed'))
    } finally {
      setBusy(false)
    }
  }

  const rows: { key: 'skillPlaza' | 'workflowPlaza' | 'knowledgeBase'; label: string }[] = [
    { key: 'skillPlaza', label: t('reviewSettingsSkill') },
    { key: 'workflowPlaza', label: t('reviewSettingsWorkflow') },
    { key: 'knowledgeBase', label: t('reviewSettingsKb') },
  ]

  return (
    <section className={styles.card} data-review-settings-card="">
      <h3 className={styles.heading}>{t('reviewSettingsTitle')}</h3>
      <p className={styles.reviewHint}>{t('reviewSettingsHint')}</p>
      {loading ? <div className={styles.status}><span>{'…'}</span></div> : (
        <div className={styles.reviewRows}>
          {rows.map(row => (
            <div key={row.key} className={styles.reviewRow}>
              <span className={styles.label}>{row.label}</span>
              <Switch
                checked={settings[row.key]}
                label={row.label}
                onChange={(next) => { setSettings(current => ({ ...current, [row.key]: next })) }}
              />
            </div>
          ))}
        </div>
      )}
      {unavailable ? <p className={styles.reviewHint} role="status">{t('reviewSettingsWaiting')}</p> : null}
      {message === null ? null : <p className={styles.reviewHint} role="status">{message}</p>}
      <div className={styles.reviewActions}>
        <Button variant="primary" size="sm" disabled={!changed || busy || loading} onClick={() => { void save() }}>
          {busy ? t('limitsSaving') : t('reviewSettingsSave')}
        </Button>
      </div>
    </section>
  )
}
