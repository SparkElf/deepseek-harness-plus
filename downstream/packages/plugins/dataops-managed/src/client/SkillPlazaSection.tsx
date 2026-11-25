import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  IconDownloadOutlineRegular,
  IconRefreshOutlineRegular,
  IconShareOutlineRegular,
  IconSkillOutlineRegular,
  IconTrashOutlineRegular,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { en } from './locales.ts'
import { fetchPlaza, postPlazaAction, type PlazaListing, type PlazaSkill } from './skill-plaza-client.ts'
import { decideReview, fetchReviewContext, reviewDemoMode, scanReview } from './review-client.ts'
import type { ReviewContext, ReviewTab, RiskReport } from './review-types.ts'
import {
  canReview,
  filterByReview,
  normalizeReviewStatus,
  normalizeVisibility,
  reviewCounts,
  reviewTabsFor,
  visibilityTag,
} from './review-types.ts'
import { demoPlazaSkills } from './review-demo.ts'
import styles from './SkillPlazaSection.module.css'

/** Values the skill center passes to a contributed section. */
export interface SkillPlazaSectionInjected {
  /** Translate one DataOps plaza message key. */
  t: (key: keyof typeof en) => string
  /**
   * The page's current search text.
   *
   * The page draws one search field for every skill it shows, and this section is part of that
   * page. Filtering here with the same text keeps the visible result consistent with the field;
   * drawing a second field would offer the same control twice and filter only half the page.
   */
  query: string
}

/** Props accepted by the plaza section. */
export type SkillPlazaSectionProps = Partial<InjectFace<SkillPlazaSectionInjected>>

/** What the section currently knows. */
type PlazaState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; listing: PlazaListing }
  | { kind: 'failed' }

/** Tab counts from the same visible rows the cards render. */
function countsOf(skills: readonly PlazaSkill[]): NonNullable<PlazaListing['counts']> {
  const counted = reviewCounts(skills)
  return {
    approved: counted.approved,
    pending: counted.pending,
    rejected: skills.filter(row => row.reviewStatus === 'rejected').length,
    total: counted.all,
  }
}

/** A plaza tab: the review states plus the department filter. */
type PlazaTab = ReviewTab | 'department'

/** One department option derived from the rows the plaza can show. */
export interface PlazaDepartmentOption {
  /** Value the select submits: the department code when the row carries one. */
  code: string
  /** Label shown in the select; never empty. */
  name: string
}

/**
 * The department a plaza row belongs to.
 *
 * The backend normally sends `departmentCode`; a legacy row may carry only a name or path, so the
 * fallbacks keep those rows selectable instead of dropping them into an empty key.
 * @param skill - one plaza row.
 * @returns the code, the name, or the deepest path name; empty when the row says nothing.
 */
export function departmentKeyOf(skill: PlazaSkill): string {
  return skill.departmentCode ?? skill.departmentName ?? skill.departmentPath?.at(-1)?.name ?? ''
}

/**
 * The department choices present in the visible rows.
 *
 * The label falls back from the row's own name to the deepest path name and finally to the code,
 * so a department the backend can no longer name still renders as a readable option.
 * @param skills - every row the current query returned.
 * @returns distinct departments, sorted by label.
 */
export function departmentOptionsOf(skills: readonly PlazaSkill[]): PlazaDepartmentOption[] {
  const options = new Map<string, string>()
  for (const skill of skills) {
    if (normalizeVisibility(skill.visibility) !== 'department') continue
    const code = departmentKeyOf(skill)
    if (code === '' || options.has(code)) continue
    options.set(code, skill.departmentName ?? skill.departmentPath?.at(-1)?.name ?? code)
  }
  return [...options].map(([code, name]) => ({ code, name })).sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))
}

/**
 * The rows the department tab shows.
 * @param skills - every row the current query returned.
 * @param code - selected department key, or an empty string for all of them.
 * @returns the department-shared rows, narrowed to `code` when it is set.
 */
export function filterByDepartment(skills: readonly PlazaSkill[], code: string): PlazaSkill[] {
  const shared = skills.filter(skill => normalizeVisibility(skill.visibility) === 'department')
  return code === '' ? shared : shared.filter(skill => departmentKeyOf(skill) === code)
}

/** One skill as a card in the plaza grid. */
function PlazaCard({ skill, busy, canAudit, onInstall, onUnshare, onReview, t }: {
  skill: PlazaSkill
  busy: boolean
  canAudit: boolean
  onInstall: () => void
  onUnshare: () => void
  onReview: () => void
  t: (key: keyof typeof en) => string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const status = normalizeReviewStatus(skill.reviewStatus)
  const tag = visibilityTag(skill)
  return (
    <li className={styles.card} data-review-status={status}>
      <div className={styles.cardTop}>
        <span className={styles.cardIcon}><IconSkillOutlineRegular size={16} /></span>
        <div className={styles.cardTitle}>{skill.name}</div>
        <span className={styles.tagTop} title={tag.detail}>{tag.label}</span>
      </div>
      <div className={styles.cardMarks}>
        {skill.sharedByMe ? <span className={styles.sharedTag}>{t('plazaSharedTag')}</span> : null}
        {status === 'pending' ? <span className={styles.pendingTag}>{t('plazaTabPending')}</span> : null}
        {status === 'rejected' ? <span className={styles.rejectedTag}>{t('plazaReject')}</span> : null}
        {skill.tags.map(item => <span className={styles.mark} key={item}>{item}</span>)}
      </div>
      <div className={styles.cardDesc}>{skill.description ?? ''}</div>
      {status === 'rejected' && skill.reviewNote !== null && skill.reviewNote !== undefined ? (
        <p className={styles.reviewNote}>{skill.reviewNote}</p>
      ) : null}
      <div className={styles.cardEnd}>
        {canAudit && status === 'pending' ? (
          <Button variant="outline" size="sm" className={styles.reviewButton} onClick={onReview}>
            {t('plazaReview')}
          </Button>
        ) : null}
        <Button variant="outline" size="sm" icon={<IconDownloadOutlineRegular size={16} />} disabled={busy} onClick={onInstall}>
          {t('plazaInstall')}
        </Button>
        {skill.sharedByMe ? (
          <Button variant="ghost" size="sm" icon={<IconTrashOutlineRegular size={16} />} disabled={busy} onClick={onUnshare}>
            {t('plazaUnshare')}
          </Button>
        ) : null}
        <Button variant="outline" size="sm" className={styles.detailButton} onClick={() => { setOpen(true) }}>
          {t('plazaShowDetail')}
        </Button>
      </div>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={skill.name}
        closeLabel={t('plazaClose')}
        className={styles.dialog as string}
        footer={<Button variant="outline" onClick={() => { setOpen(false) }}>{t('plazaClose')}</Button>}
      >
        <dl className={styles.detail}>
          <div className={styles.detailRow}><dt className={styles.detailLabel}>{t('plazaDetailUpdated')}</dt><dd className={styles.detailValue}>{skill.updatedAt}</dd></div>
          <div className={styles.detailRow}><dt className={styles.detailLabel}>{t('plazaDetailBody')}</dt><dd className={styles.detailValue}>{skill.instruction}</dd></div>
        </dl>
      </Modal>
    </li>
  )
}

/** The AI report block inside the audit dialog. */
function RiskReportView({ report, busy, failed, onScan, t }: {
  report: RiskReport | null
  busy: boolean
  failed: boolean
  onScan: () => void
  t: (key: keyof typeof en) => string
}): ReactNode {
  return (
    <section className={styles.risk}>
      <div className={styles.riskHead}>
        <strong>{t('plazaRiskTitle')}</strong>
        <Button variant="outline" size="sm" disabled={busy} onClick={onScan}>
          {busy ? t('plazaRiskScanning') : t('plazaRiskScan')}
        </Button>
      </div>
      {failed ? <p className={styles.riskFailed}>{t('plazaRiskFailed')}</p> : null}
      {report === null ? (busy ? null : <p className={styles.riskEmpty}>{t('plazaRiskNone')}</p>) : (
        <>
          <div className={styles.riskSummary}>
            {report.score === undefined ? null : <span className={styles.riskScore}>{t('plazaRiskScore')} {report.score}</span>}
            {report.severity === undefined ? null : <span className={styles.severity} data-severity={report.severity}>{report.severity}</span>}
            {report.summary === undefined ? null : <span>{report.summary}</span>}
          </div>
          <ul className={styles.findings}>
            {report.findings.map((finding, index) => (
              <li key={String(index)} className={styles.finding}>
                <span className={styles.severity} data-severity={finding.severity}>{finding.severity}</span>
                <strong>{finding.category}</strong>
                {finding.evidence === undefined ? null : <span className={styles.findingText}>{finding.evidence}</span>}
                {finding.recommendation === undefined ? null : <span className={styles.findingHint}>{finding.recommendation}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/**
 * Browse, share, and install skills other users published.
 *
 * Review is a permissioned overlay on the same plaza: the tab strip and the audit dialog only
 * appear when the Host says the caller may review, and the Host additionally narrows the pending
 * list to the caller's department subtree.
 */
export function SkillPlazaSection(props: SkillPlazaSectionProps): ReactNode {
  const { t } = props
  const [state, setState] = useState<PlazaState>({ kind: 'loading' })
  const [context, setContext] = useState<ReviewContext | null | undefined>(undefined)
  const [tab, setTab] = useState<PlazaTab>('approved')
  const [department, setDepartment] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [audit, setAudit] = useState<PlazaSkill | null>(null)
  const [risk, setRisk] = useState<RiskReport | null>(null)
  const [riskBusy, setRiskBusy] = useState(false)
  const [riskFailed, setRiskFailed] = useState(false)
  const [reviewNote, setReviewNote] = useState('')
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const query = props.query ?? ''
  const allowed = canReview(context)

  useEffect(() => {
    let live = true
    void fetchReviewContext().then((next) => { if (live) setContext(next) }).catch(() => { if (live) setContext(null) })
    return () => { live = false }
  }, [])

  const load = useCallback(async (filter: { query: string }) => {
    try {
      // The demo fixture is complete on its own: mixing it with a live list would still call a
      // backend whose review endpoints have not shipped, which is exactly what the fixture exists
      // to review without.
      if (reviewDemoMode()) {
        const demo = demoPlazaSkills()
        setState({
          kind: 'ready',
          listing: {
            skills: [...demo],
            tags: [],
            counts: countsOf(demo),
          },
        })
        return
      }
      // One visible snapshot per query. The tab and the department are client-side filters, so the
      // count on each tab is always the number of cards that tab will actually show.
      const listing = await fetchPlaza({ query: filter.query, status: allowed ? 'all' : 'approved' })
      if (listing === null) {
        setState({ kind: 'unavailable' })
        return
      }
      const visible = allowed ? listing.skills : listing.skills.filter(row => normalizeReviewStatus(row.reviewStatus) === 'approved')
      setState({ kind: 'ready', listing: { ...listing, skills: [...visible], counts: countsOf(visible) } })
    } catch {
      setState({ kind: 'failed' })
    }
  }, [allowed])

  useEffect(() => { void load({ query }) }, [load, query])

  const refresh = useCallback(async () => {
    await load({ query })
  }, [load, query])

  const act = useCallback(async (body: Record<string, unknown>, message: string) => {
    setBusy(true)
    setNotice(null)
    try {
      await postPlazaAction(body)
      setNotice(message)
      await refresh()
    } catch {
      setNotice(t === undefined ? null : t('plazaActionFailed'))
    } finally {
      setBusy(false)
    }
  }, [refresh, t])

  const runScan = async (skill: PlazaSkill): Promise<void> => {
    setRiskBusy(true)
    setRiskFailed(false)
    try {
      const report = await scanReview('skill', [skill.id])
      if (report === null) setRiskFailed(true)
      else setRisk(report)
    } catch {
      setRiskFailed(true)
    } finally {
      setRiskBusy(false)
    }
  }

  const openAudit = (skill: PlazaSkill): void => {
    setAudit(skill)
    setRisk(skill.riskReport ?? null)
    setRiskFailed(false)
    setReviewNote('')
    setReviewError(null)
    if (skill.riskReport === null || skill.riskReport === undefined) void runScan(skill)
  }

  const submitReview = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (audit === null || reviewBusy) return
    if (decision === 'reject' && reviewNote.trim() === '') {
      setReviewError(t === undefined ? null : t('plazaReviewNote'))
      return
    }
    setReviewBusy(true)
    setReviewError(null)
    try {
      const ok = await decideReview('skill', [audit.id], decision, reviewNote.trim())
      if (!ok) {
        setReviewError(t === undefined ? null : t('plazaReviewFailed'))
        return
      }
      setAudit(null)
      setNotice(t === undefined ? null : t('plazaReviewDone'))
      setTab('pending')
      await refresh()
    } catch {
      setReviewError(t === undefined ? null : t('plazaReviewFailed'))
    } finally {
      setReviewBusy(false)
    }
  }

  if (t === undefined) return null
  if (state.kind === 'loading') return null

  const head = (count: number | null): ReactNode => (
    <div className={styles.head}>
      <div className={styles.headRow}>
        <h2 className={styles.title}>
          {t('plazaTitle')}
          {count === null ? null : <span className={styles.titleCount}>{count}</span>}
        </h2>
        {reviewDemoMode() ? <span className={styles.demoTag}>{t('plazaDemo')}</span> : null}
      </div>
    </div>
  )

  if (state.kind === 'unavailable') {
    return <section className={styles.section}>{head(null)}<p className={styles.status}>{t('plazaUnavailable')}</p></section>
  }
  if (state.kind === 'failed') {
    return (
      <section className={styles.section}>
        {head(null)}
        <div className={styles.empty} role="alert">
          <span className={styles.emptyIcon}><IconSkillOutlineRegular size={28} /></span>
          <p className={styles.emptyText}>{t('plazaLoadFailed')}</p>
          <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={16} />} onClick={() => { void refresh() }}>{t('plazaRetry')}</Button>
        </div>
      </section>
    )
  }

  const { listing } = state
  const counts: Record<ReviewTab, number> = listing.counts === undefined
    ? reviewCounts(listing.skills)
    : { approved: listing.counts.approved, pending: listing.counts.pending, all: listing.counts.total }
  const reviewTabs = reviewTabsFor(context)
  const departmentOptions = departmentOptionsOf(listing.skills)
  // A department deleted or renamed away after the selection was made falls back to "all", so the
  // select never holds a value that is absent from its own options.
  const selectedDepartment = departmentOptions.some(option => option.code === department) ? department : ''
  const departmentSkills = filterByDepartment(listing.skills, selectedDepartment)
  const tabs: readonly PlazaTab[] = departmentOptions.length === 0 ? reviewTabs : [...reviewTabs, 'department']
  const countOfTab = (item: PlazaTab): number => item === 'department' ? departmentSkills.length : counts[item]
  const tabLabel = (item: PlazaTab): string => item === 'approved' ? t('plazaTabApproved')
    : item === 'pending' ? t('plazaTabPending')
      : item === 'all' ? t('plazaTabAll')
        : t('plazaTabDepartment')
  const visibleSkills = tab === 'department' ? departmentSkills : filterByReview(listing.skills, tab)

  return (
    <section className={styles.section}>
      {head(countOfTab(tab))}
      {tabs.length > 1 ? (
        <div className={styles.tabs} role="tablist" aria-label={t('plazaTitle')}>
          {tabs.map(item => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              className={tab === item ? styles.tab + ' ' + styles.tabActive : styles.tab}
              onClick={() => { setTab(item) }}
            >
              {tabLabel(item)}
              <span className={styles.tabCount}>{countOfTab(item)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {tab === 'department' && departmentOptions.length > 0 ? (
        <label className={styles.departmentBar}>
          <span className={styles.departmentLabel}>{t('plazaDepartment')}</span>
          <select
            className={styles.departmentSelect}
            value={selectedDepartment}
            aria-label={t('plazaDepartment')}
            onChange={(event) => { setDepartment(event.target.value) }}
          >
            <option value="">{t('plazaDepartmentAll')}</option>
            {departmentOptions.map(option => (
              <option key={option.code} value={option.code}>{option.name}</option>
            ))}
          </select>
        </label>
      ) : null}

      {notice === null ? null : <p className={styles.notice}>{notice}</p>}

      {visibleSkills.length === 0 ? (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}><IconShareOutlineRegular size={28} /></span>
          <p className={styles.emptyText}>
            {tab === 'department' ? t('plazaDepartmentEmpty') : tab === 'pending' ? t('plazaPendingEmpty') : t('plazaEmpty')}
          </p>
        </div>
      ) : null}

      <ul className={styles.cards}>
        {visibleSkills.map(skill => (
          <PlazaCard
            key={skill.id}
            skill={skill}
            busy={busy}
            canAudit={allowed}
            t={t}
            onInstall={() => { void act({ action: 'install', id: skill.id }, t('plazaInstalled')) }}
            onUnshare={() => { void act({ action: 'unshare', id: skill.id }, t('plazaUnshared')) }}
            onReview={() => { openAudit(skill) }}
          />
        ))}
      </ul>

      <Modal
        open={audit !== null}
        onClose={() => { if (!reviewBusy) setAudit(null) }}
        title={t('plazaAuditTitle')}
        closeLabel={t('plazaClose')}
        className={styles.auditDialog as string}
        footer={(
          <div className={styles.auditFooter}>
            <Button variant="outline" disabled={reviewBusy} onClick={() => { setAudit(null) }}>{t('plazaClose')}</Button>
            <Button variant="outline" disabled={reviewBusy} onClick={() => { void submitReview('reject') }}>{t('plazaReject')}</Button>
            <Button variant="primary" disabled={reviewBusy} onClick={() => { void submitReview('approve') }}>{t('plazaApprove')}</Button>
          </div>
        )}
      >
        {audit === null ? null : (
          <div className={styles.audit}>
            <dl className={styles.detail}>
              <div className={styles.detailRow}><dt className={styles.detailLabel}>{t('plazaAuditSource')}</dt><dd className={styles.detailValue}>{audit.ownerName ?? '—'} · {visibilityTag(audit).detail}</dd></div>
              <div className={styles.detailRow}><dt className={styles.detailLabel}>{t('plazaAuditVisibility')}</dt><dd className={styles.detailValue}>{visibilityTag(audit).label}</dd></div>
              <div className={styles.detailRow}><dt className={styles.detailLabel}>{t('plazaShowDetail')}</dt><dd className={styles.detailValue}>{audit.description ?? '—'}</dd></div>
            </dl>
            <RiskReportView report={risk} busy={riskBusy} failed={riskFailed} onScan={() => { void runScan(audit) }} t={t} />
            <label className={styles.noteField}>
              <span>{t('plazaReviewNote')}</span>
              <textarea value={reviewNote} placeholder={t('plazaReviewNotePlaceholder')} onChange={(event) => { setReviewNote(event.target.value) }} />
            </label>
            {reviewError === null ? null : <p className={styles.reviewError} role="alert">{reviewError}</p>}
          </div>
        )}
      </Modal>
    </section>
  )
}

/** Re-exported so the registration site reads the route from one place. */
export { SKILL_PLAZA_PATH } from './skill-plaza-client.ts'