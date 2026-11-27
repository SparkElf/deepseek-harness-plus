/**
 * Shared "vector retrieval" settings group.
 *
 * One component owns the config/status reads, the save call and the rebuild poll so
 * the DSH Settings section and the knowledge-base panel's own Settings page cannot
 * drift. The group is deliberately self-loading: a profile that never mounts
 * `settings.section` still gets the same controls because the panel renders this
 * component directly.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  KB_API,
  kbApiPath,
  type KnowledgeConfigView,
  type KnowledgeStatusView,
} from '../api.ts'
import styles from './KnowledgeSettingsSection.module.css'

/** Copy resolver; accepts both the DSH settings locale function and the panel one. */
export type VectorSettingsT = (key: any) => string

interface VectorDraft {
  enabled: boolean
  provider: 'openai-compatible' | 'ollama'
  baseUrl: string
  model: string
  dimensions: string
  credentialRef: string
  rrfK: string
  candidateK: string
  ftsWeight: string
  vectorWeight: string
}

const EMPTY: VectorDraft = {
  enabled: false,
  provider: 'openai-compatible',
  baseUrl: '',
  model: '',
  dimensions: '0',
  credentialRef: '',
  rrfK: '60',
  candidateK: '50',
  ftsWeight: '1',
  vectorWeight: '0.5',
}

function draftOf(config: KnowledgeConfigView): VectorDraft {
  const vector = config.retrieval?.vector
  if (vector === undefined) return { ...EMPTY }
  return {
    enabled: vector.enabled === true,
    provider: vector.provider === 'ollama' ? 'ollama' : 'openai-compatible',
    baseUrl: vector.baseUrl ?? '',
    model: vector.model ?? '',
    dimensions: String(vector.dimensions ?? 0),
    credentialRef: vector.credentialRef ?? '',
    rrfK: String(vector.rrfK ?? 60),
    candidateK: String(vector.candidateK ?? 50),
    ftsWeight: String(vector.ftsWeight ?? 1),
    vectorWeight: String(vector.vectorWeight ?? 0.5),
  }
}

async function postJson<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(kbApiPath(method as never), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  const decoded = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(decoded.error ?? `HTTP ${String(response.status)}`)
  return decoded
}

/** One self-contained vector settings group. */
export function VectorSettingsGroup({ t }: { t: VectorSettingsT }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [config, setConfig] = useState<KnowledgeConfigView | undefined>(undefined)
  const [status, setStatus] = useState<KnowledgeStatusView | undefined>(undefined)
  const [draft, setDraft] = useState<VectorDraft>({ ...EMPTY })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true); setError(undefined)
    try {
      const [nextConfig, nextStatus] = await Promise.all([
        postJson<KnowledgeConfigView>(KB_API.config),
        postJson<KnowledgeStatusView>(KB_API.status),
      ])
      setConfig(nextConfig)
      setStatus(nextStatus)
      setDraft(draftOf(nextConfig))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const canEdit = status?.vector?.canManageVector === true

  const save = async (): Promise<void> => {
    setBusy(true); setNotice(undefined)
    const dimensions = Number(draft.dimensions)
    const rrfK = Number(draft.rrfK)
    const candidateK = Number(draft.candidateK)
    const ftsWeight = Number(draft.ftsWeight)
    const vectorWeight = Number(draft.vectorWeight)
    if (!Number.isInteger(dimensions) || dimensions < 0
      || !Number.isFinite(rrfK) || rrfK <= 0
      || !Number.isInteger(candidateK) || candidateK <= 0 || candidateK > 200
      || !Number.isFinite(ftsWeight) || ftsWeight < 0
      || !Number.isFinite(vectorWeight) || vectorWeight < 0) {
      setNotice(t('vectorBadNumber'))
      setBusy(false)
      return
    }
    try {
      await postJson(KB_API.configSet, {
        retrieval: {
          vector: {
            enabled: draft.enabled,
            provider: draft.provider,
            baseUrl: draft.baseUrl,
            model: draft.model,
            dimensions,
            credentialRef: draft.credentialRef,
            rrfK,
            candidateK,
            ftsWeight,
            vectorWeight,
          },
        },
      })
      setNotice(t('settingsSaved'))
      await load()
    } catch (saveError) {
      setNotice(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setBusy(false)
    }
  }

  const rebuild = async (): Promise<void> => {
    if (!window.confirm(t('vectorRebuildConfirm'))) return
    setBusy(true); setNotice(undefined)
    try {
      await postJson(KB_API.vectorRebuild, { confirmed: true })
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        const latest = await postJson<KnowledgeStatusView>(KB_API.status)
        setStatus(latest)
        if (latest.vector?.indexing.running !== true) break
      }
      setNotice(t('settingsSaved'))
    } catch (rebuildError) {
      setNotice(rebuildError instanceof Error ? rebuildError.message : String(rebuildError))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <p className={styles.detail}>{t('settingsLoading')}</p>
  if (error !== undefined || config === undefined) {
    return <p className={styles.error}>{t('settingsLoadFailed')}{error === undefined ? '' : ` ${error}`}</p>
  }

  return (
    <div className={styles.body}>
      <h3 className={styles.groupTitle}>{t('vectorHeading')}</h3>
      <p className={styles.detail}>{t('vectorHint')}</p>
      <div className={styles.pair}>
        <Switch
          checked={draft.enabled}
          disabled={!canEdit || busy}
          onChange={(next) => { setDraft(current => ({ ...current, enabled: next })); setNotice(undefined) }}
          label={t('vectorEnabled')}
        />
        <span className={styles.detail}>{draft.enabled ? t('vectorEnabledOn') : t('vectorEnabledOff')}</span>
      </div>
      <dl className={styles.pairs}>
        <div className={styles.pair}>
          <dt>{t('vectorProvider')}</dt>
          <dd>
            <select className={styles.select} value={draft.provider} disabled={!canEdit || busy}
              onChange={(event) => { setDraft(current => ({ ...current, provider: event.target.value === 'ollama' ? 'ollama' : 'openai-compatible' })); setNotice(undefined) }}>
              <option value="openai-compatible">OpenAI-compatible</option>
              <option value="ollama">Ollama</option>
            </select>
          </dd>
        </div>
        <div className={styles.pair}>
          <dt>{t('vectorBaseUrl')}</dt>
          <dd><input className={styles.input} type="url" value={draft.baseUrl} placeholder="http://127.0.0.1:11434" disabled={!canEdit || busy} onChange={(event) => { setDraft(current => ({ ...current, baseUrl: event.target.value })); setNotice(undefined) }} /></dd>
        </div>
        <div className={styles.pair}>
          <dt>{t('vectorModel')}</dt>
          <dd><input className={styles.input} type="text" value={draft.model} placeholder="text-embedding-3-small" disabled={!canEdit || busy} onChange={(event) => { setDraft(current => ({ ...current, model: event.target.value })); setNotice(undefined) }} /></dd>
        </div>
        <div className={styles.pair}>
          <dt>{t('vectorDimensions')}</dt>
          <dd><input className={styles.input} type="number" min={0} value={draft.dimensions} disabled={!canEdit || busy} onChange={(event) => { setDraft(current => ({ ...current, dimensions: event.target.value })); setNotice(undefined) }} /></dd>
        </div>
        <div className={styles.pair}>
          <dt>{t('vectorCredentialRef')}</dt>
          <dd>
            <input className={styles.input} type="text" value={draft.credentialRef} placeholder="DATAOPS_KB_EMBEDDING_KEY" disabled={!canEdit || busy} onChange={(event) => { setDraft(current => ({ ...current, credentialRef: event.target.value })); setNotice(undefined) }} />
            <span className={styles.detail}>{t('vectorCredentialHint')}</span>
          </dd>
        </div>
        <div className={styles.pair}>
          <dt>{t('vectorRrfK')}</dt>
          <dd><input className={styles.input} type="number" min={1} value={draft.rrfK} disabled={!canEdit || busy} onChange={(event) => { setDraft(current => ({ ...current, rrfK: event.target.value })); setNotice(undefined) }} /></dd>
        </div>
        <div className={styles.pair}>
          <dt>{t('vectorCandidateK')}</dt>
          <dd><input className={styles.input} type="number" min={1} max={200} value={draft.candidateK} disabled={!canEdit || busy} onChange={(event) => { setDraft(current => ({ ...current, candidateK: event.target.value })); setNotice(undefined) }} /></dd>
        </div>
        <div className={styles.pair}>
          <dt>{t('vectorWeights')}</dt>
          <dd>
            <input className={styles.input} type="number" min={0} step={0.1} value={draft.ftsWeight} aria-label={t('vectorFtsWeight')} disabled={!canEdit || busy} onChange={(event) => { setDraft(current => ({ ...current, ftsWeight: event.target.value })); setNotice(undefined) }} />
            <input className={styles.input} type="number" min={0} step={0.1} value={draft.vectorWeight} aria-label={t('vectorVectorWeight')} disabled={!canEdit || busy} onChange={(event) => { setDraft(current => ({ ...current, vectorWeight: event.target.value })); setNotice(undefined) }} />
            <span className={styles.detail}>{t('vectorWeightsHint')}</span>
          </dd>
        </div>
      </dl>
      <p className={styles.detail}>
        {t('vectorCoverage').replace('{embedded}', String(status?.vector?.embeddedChunks ?? 0)).replace('{total}', String(status?.vector?.totalChunks ?? 0)).replace('{failed}', String(status?.vector?.failed ?? 0))}
      </p>
      {status?.vector?.indexing.running === true && (
        <p className={styles.detail}>{t('vectorProgress').replace('{done}', String(status.vector.indexing.done ?? 0)).replace('{total}', String(status.vector.indexing.total ?? 0))}</p>
      )}
      {!canEdit && <p className={styles.detail}>{t('settingsReadOnly')}</p>}
      {notice !== undefined && <p className={styles.detail}>{notice}</p>}
      <div className={styles.saveRow}>
        <Button variant="outline" disabled={!canEdit || busy} onClick={() => { void save() }}>{t('settingsSave')}</Button>
        <Button variant="outline" disabled={!canEdit || !draft.enabled || busy || status?.vector?.indexing.running === true} onClick={() => { void rebuild() }}>{t('vectorRebuild')}</Button>
      </div>
      <p className={styles.detail}>{t('vectorRebuildHint')}</p>
    </div>
  )
}
