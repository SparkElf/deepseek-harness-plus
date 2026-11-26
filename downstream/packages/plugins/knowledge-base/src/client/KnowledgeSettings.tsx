/**
 * TODO: this page is unreachable from the real entry, and needs a decision.
 *
 * Verified by driving the deployed product on 2026-10-21, not by reading the code:
 * entering 知识库 and clicking 「设置」 in its own rail opens the DSH GLOBAL settings
 * dialog (left nav: 通用设置/模型/内置插件/Agent 预设/DataOps/备份/知识库/插件市场/
 * 侧边卡片), never this component. The rail row sets `selection.kind = 'settings'`,
 * which `KnowledgePanel.tsx` renders as this surface, but the click that a reader can
 * actually reach is the shell's own settings entry, so nothing in the real UI leads
 * here. The review switch below therefore has no user-facing effect today.
 *
 * Deliberately NOT deleted: removing this file, the `rendered.kind === 'settings'`
 * branch in `KnowledgePanel.tsx` and the `menu.settings` rail row is a cross-file
 * structural change, and the choice between "delete the page" and "give it a real
 * entry point" is a product decision rather than a cleanup. Left as-is with this note
 * so the next change starts from the measured fact instead of re-deriving it.
 *
 * What WAS moved: the MinerU service address. It lived here for one round and was
 * invisible to readers for exactly this reason; it now renders in
 * `KnowledgeSettingsSection.tsx` (DSH global settings → 知识库), which is reachable.
 */
/**
 * The settings surface of the management page.
 *
 * This page carries the review switch and the shared vector-retrieval group: the
 * switch is a DECISION about whether other people's contributions take effect
 * immediately, so it needs write access; the vector group is the same component the
 * DSH settings section renders, which keeps a profile without that slot usable. The queue that decision governs and the trail of what it settled both
 * moved to the Audit page, which is the surface an operator opens to get through
 * work; parking a worklist under a configuration switch made them scroll past the
 * setting to reach today's arrivals, and left two duplicate entry points pointing
 * at the same two tables.
 *
 * The switch ships OFF. That is the product decision, not a default that drifted: an
 * operator who never opens this page keeps the behaviour they had, and turning review
 * on is a deliberate act with a visible consequence.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath } from '../api.ts'
import tableStyles from './KnowledgePermissions.module.css'
import styles from './KnowledgePanel.module.css'
import { VectorSettingsGroup } from './VectorSettingsGroup.tsx'

/** This knowledge base's review settings, as the Host reports them. */
export interface KnowledgeSettingsView {
  /** Whether a write must be reviewed before it counts as published. */
  reviewRequired: boolean
  /**
   * MinerU's full base address, or `''` to derive it from the configured port.
   *
   * Absent from an older Host's answer, which reads as `''`: the field then shows
   * "derived" rather than a value the Host never sent.
   */
  mineruBaseUrl?: string
}

/** One recorded change, as the Host reports it. */
export interface KnowledgeAuditEntryView {
  /** ISO timestamp of the action. */
  at: string
  /** DataOps user id that performed it: the identity the trail is checked against. */
  actor: string
  /**
   * That user's display name, when the entry carries one.
   *
   * Absent on entries written before it was recorded; the column falls back to the
   * id so an old line still identifies its actor.
   */
  actorLabel?: string
  /** What they did. Mirrors the Host's own action union. */
  action: 'create' | 'upload' | 'move' | 'approve' | 'reject' | 'edit'
  /** The path the action concerned. */
  relPath: string
  /** For a move, the destination path. */
  toRelPath?: string
  /** Whether it took effect immediately or was parked for review or refused. */
  outcome: 'applied' | 'pending' | 'rejected'
}

/** Props for the settings surface. */
export interface KnowledgeSettingsProps {
  /** Locale-bound copy for this package's namespace. */
  t: (key: string) => string
}

/** One submission waiting for review, as the Host reports it. */
export interface PendingWriteView {
  /** The parking name a decision is made against. */
  name: string
  /** Who submitted it. */
  userId: string
  /** The path it wants to occupy. */
  relPath: string
  /** When it was submitted. */
  at: string
  /** Size of the submitted bytes. */
  bytes: number
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; settings: KnowledgeSettingsView; canEdit: boolean }
  | { kind: 'error'; message: string }

/**
 * Render the review switch and the audit trail.
 * @param props - copy resolver.
 * @returns The settings surface.
 */
export function KnowledgeSettings(props: KnowledgeSettingsProps) {
  /** Copy resolver, bound from the page so this surface writes no literals. */
  const c = props.t
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(kbApiPath(KB_API.settingsGet), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      })
      // This is the one read the page exists for, so a failure here blanks it rather
      // than showing a switch whose position would be a guess.
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      const body = (await response.json()) as { settings?: KnowledgeSettingsView; canEdit?: boolean }
      setState({
        kind: 'ready',
        settings: {
          reviewRequired: body.settings?.reviewRequired === true,
          mineruBaseUrl: typeof body.settings?.mineruBaseUrl === 'string' ? body.settings.mineruBaseUrl : '',
        },
        canEdit: body.canEdit === true,
      })
    } catch (error: unknown) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /**
   * Flip the review switch, then re-read so the shown value is the stored one.
   * @param next - the requested value.
   */
  const setReview = async (next: boolean): Promise<void> => {
    setBusy(true); setNotice(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.settingsSet), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewRequired: next }),
        cache: 'no-store',
      })
      const body = (await response.json()) as { settings?: KnowledgeSettingsView; error?: string }
      if (!response.ok) throw new Error(body.error ?? 'HTTP ' + String(response.status))
      setNotice(c('settingsSaved'))
      // Re-read rather than trusting the local value: the Host normalises, and the
      // rendered switch must show what is stored.
      await load()
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : c('settingsSaveFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (state.kind === 'loading') {
    return <div className={styles.notice}>{c('settingsLoading')}</div>
  }
  if (state.kind === 'error') {
    return <div className={styles.notice}>{c('settingsLoadFailed')}</div>
  }

  const { settings, canEdit } = state

  return (
    <div className={styles.contentColumn}>
      {/* The panel header already names this surface; the h1 here repeated it. */}
      <section className={styles.surface}>
        <h2 className={styles.subhead}>{c('settingsReviewHeading')}</h2>
        {c('settingsReviewHint') === '' ? null : <p className={tableStyles.pageHint}>{c('settingsReviewHint')}</p>}
        <div className={styles.pair}>
          <Switch
            checked={settings.reviewRequired}
            disabled={!canEdit || busy}
            onChange={(next) => { void setReview(next) }}
            label={c('settingsReviewLabel')}
          />
          <span className={tableStyles.pageHint}>
            {settings.reviewRequired ? c('settingsReviewOn') : c('settingsReviewOff')}
          </span>
        </div>
        {!canEdit && <p className={tableStyles.pageHint}>{c('settingsReadOnly')}</p>}
        {notice !== undefined && <p className={tableStyles.pageHint}>{notice}</p>}
      </section>
      <section className={styles.surface}>
        <VectorSettingsGroup t={c as (key: string) => string} />
      </section>

    </div>
  )
}
