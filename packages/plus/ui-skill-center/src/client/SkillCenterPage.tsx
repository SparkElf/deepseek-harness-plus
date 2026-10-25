/**
 * Skill center page. Browses the loaded skills grouped by source, toggles model
 * invocation, creates a skill, and deletes one into a recoverable trash.
 *
 * The header, rows, and glyph frame follow the official plugin panel's layout so
 * the page reads as one of the shell's own.
 *
 * @module @sparkelf/dsh-client-ui-skill-center/client/SkillCenterPage
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Button,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  IconSkillOutlineRegular,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slot-contract.ts'
import css from './SkillCenterPage.module.css'
import { SkillApi, type ListPayload, type SkillEntry, type TranslationProgress } from './api.ts'
import type { SkillCenterLocaleKey } from './locales.ts'
import { PlazaUnavailableError, type PlazaSkill } from './api.ts'
import { canSubmit, shareOf, type PlazaShare } from './plaza.ts'
import {
  allowedVisibilities, ownDepartment, readAccountIdentity, readSavedScope,
  sanitizeChoice, scopeRole, scopeStorageKey, writeSavedScope,
  type Department, type PlazaVisibility, type ReviewScope,
} from './scope.ts'

/** What the panel needs from its slot: the dictionary resolver. */
export interface SkillCenterPageProps {
  t(key: SkillCenterLocaleKey): string
}

/** One workspace row as the root seat publishes it. */
interface WorkspaceRow {
  readonly path: string
  readonly sessionIds: readonly string[]
}

/**
 * The root seat `ui-workspace` publishes through `slots.provideRoot`.
 *
 * Declared structurally rather than imported: the seat's owning package is not a
 * dependency of this one, and the panel only needs the row fields it reads.
 */
type WorkspaceSeat = (selector: (snapshot: { items: readonly WorkspaceRow[] }) => readonly WorkspaceRow[]) => readonly WorkspaceRow[]

/** Client-side group shape, as the list route serves it. */
interface Group {
  key: string
  title: string
  skills: SkillEntry[]
}

/** How the panel is currently showing the list. */
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; payload: ListPayload }
  | { kind: 'failed'; message: string }

/** How the detail dialog is currently showing one skill's body. */
type BodyState =
  | { kind: 'loading' }
  | { kind: 'ready'; content: string }
  | { kind: 'failed'; message: string }

/**
 * One labelled create-form field.
 * @param props - the field's label and the control it wraps.
 * @returns the labelled field.
 */
function DraftField({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className={css.field}>
      <span className={css.fieldLabel}>{label}</span>
      {children}
    </div>
  )
}

/**
 * One skill row, with the dialog that shows the skill's own Markdown.
 * @param props - the entry, the API client and viewing context its body is read
 * with, its toggle, and its delete action.
 * @returns the row.
 */
function SkillCard({ skill, api, cwd, t, share, shareBusy, shareDisabled, onToggle, onDelete, onShare, onUnshare }: {
  skill: SkillEntry
  api: SkillApi
  cwd: string | undefined
  t: (key: SkillCenterLocaleKey) => string
  share: PlazaShare
  shareBusy: boolean
  shareDisabled: boolean
  onToggle(skill: SkillEntry, enabled: boolean): void
  onDelete(skill: SkillEntry): void
  onShare(skill: SkillEntry): void
  onUnshare(skill: SkillEntry, id: number): void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState<BodyState>({ kind: 'loading' })
  // The body is read when the dialog opens rather than with the list: the listing spans
  // every workspace a session names, and pulling every skill's Markdown would cost a read
  // per row for text most rows never show.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setBody({ kind: 'loading' })
    void api.content(skill.name, skill.path, cwd)
      .then((payload) => { if (!cancelled) setBody({ kind: 'ready', content: payload.content }) })
      .catch((error: unknown) => {
        if (!cancelled) setBody({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
      })
    return () => { cancelled = true }
  }, [open, api, skill.name, skill.path, cwd])
  // A project skill can come from a workspace other than the one being viewed — the
  // listing spans every workspace a session names — so its origin is shown rather
  // than left to look like it belongs to the workspace on screen.
  const foreign = skill.isActiveWorkspace === false && skill.workspaceName !== undefined
  const shareLabel = share.status === 'approved' ? t('plaza.statusApproved')
    : share.status === 'pending' ? t('plaza.statusPending')
      : share.status === 'rejected' ? t('plaza.statusRejected') : t('plaza.statusLocal')
  // What a user opens a card to read, in the order that answers "where does this come from and
  // when does it fire". A bundled skill has neither a when-to-use line nor a path — it ships
  // inside the runtime — so its level and provider are what the disclosure can state.
  const details: { key: SkillCenterLocaleKey; value: string }[] = []
  if (skill.whenToUse !== undefined) details.push({ key: 'detail.whenToUse', value: skill.whenToUse })
  details.push({ key: 'detail.source', value: skill.level })
  if (skill.provider !== undefined) details.push({ key: 'detail.provider', value: skill.provider })
  if (skill.path !== undefined) details.push({ key: 'detail.path', value: skill.path })
  return (
    <li className={foreign ? css.card + ' ' + css.cardForeign : css.card} data-skill-name={skill.name} data-plaza-status={share.status}>
      <div className={css.cardHead}>
        <span className={css.cardIcon}><IconSkillOutlineRegular size={16} /></span>
        <div className={css.cardTitleRow}>
          <div className={css.cardTitle}>{skill.i18n?.title ?? skill.name}</div>
          {skill.workspaceName === undefined ? null : (
            <span className={css.workspaceBadge}>{skill.workspaceName}</span>
          )}
          <span
            className={css.plazaBadge + ' ' + (share.status === 'approved' ? css.plazaBadgeApproved : share.status === 'rejected' ? css.plazaBadgeRejected : share.status === 'pending' ? css.plazaBadgePending : css.plazaBadgeLocal)}
            data-plaza-status={share.status}
          >
            {shareLabel}
          </span>
          {share.status === 'approved' ? <span className={css.plazaSharedTag} data-plaza-shared>{t('plaza.sharedTag')}</span> : null}
        </div>
      </div>
      <div className={css.cardBody}>
        {/* One line of copy on a card: the summary a translation carries, and the
            registry description when there is no translation to summarize. */}
        <div className={css.cardSummary}>{skill.i18n?.summary ?? skill.description}</div>
        {share.status === 'rejected' && share.record?.reviewNote !== undefined ? (
          <div className={css.plazaReason}>{t('plaza.reason')}: {share.record.reviewNote}</div>
        ) : null}
        <div className={css.cardMarks}>
          <span className={skill.modelInvocable ? css.mark + ' ' + css.markOn : css.mark + ' ' + css.markOff}>
            {t('skill.modelInvocable')}
          </span>
          <span className={skill.userInvocable ? css.mark + ' ' + css.markOn : css.mark + ' ' + css.markOff}>
            {t('skill.userInvocable')}
          </span>
          {skill.linked === true ? <span className={css.mark + ' ' + css.markDanger}>{t('skill.linked')}</span> : null}
        </div>
      </div>
      <div className={css.cardEnd}>
        <button
          type="button"
          className={skill.modelInvocable ? css.switch + ' ' + css.switchOn : css.switch}
          aria-label={skill.modelInvocable ? t('skill.disabled') : t('skill.enabled')}
          aria-pressed={skill.modelInvocable}
          onClick={() => { onToggle(skill, !skill.modelInvocable) }}
        />
        <div className={css.cardActions}>
          {canSubmit(share.status) ? (
            <Button variant="primary" size="sm" disabled={shareBusy || shareDisabled} onClick={() => { onShare(skill) }}>
              {share.status === 'rejected' ? t('plaza.resubmit') : t('plaza.share')}
            </Button>
          ) : null}
          {share.sharedByMe && share.record !== undefined ? (
            <Button variant="outline" size="sm" disabled={shareBusy} onClick={() => { if (share.record !== undefined) onUnshare(skill, share.record.id) }}>
              {t('plaza.unshare')}
            </Button>
          ) : null}
          {skill.path === undefined || skill.linked === true ? null : (
            <Button variant="outline" size="sm" onClick={() => { onDelete(skill) }}>
              {t('action.delete')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => { setOpen(true) }}>
            {t('action.showDetail')}
          </Button>
        </div>
      </div>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={skill.name}
        closeLabel={t('action.close')}
        className={css.dialog as string}
        footer={(
          <Button variant="outline" onClick={() => { setOpen(false) }}>{t('action.close')}</Button>
        )}
      >
        <dl className={css.detail}>
          {details.map(item => (
            <div className={css.detailRow} key={item.key}>
              <dt className={css.detailLabel}>{t(item.key)}</dt>
              <dd className={css.detailValue}>{item.value}</dd>
            </div>
          ))}
        </dl>
        {/* What the dialog is opened for: the skill's own Markdown, as the file
            holds it. Plain text, so nothing in a skill body can restyle the panel. */}
        <section className={css.body}>
          <h3 className={css.bodyLabel}>{t('detail.content')}</h3>
          {body.kind === 'loading' ? <p className={css.bodyStatus}>{t('content.loading')}</p> : null}
          {body.kind === 'failed' ? (
            <p className={css.bodyError}>{t('content.failed')}: {body.message}</p>
          ) : null}
          {body.kind === 'ready' ? (
            <pre className={css.bodyPre} data-skill-body={skill.name}>{body.content}</pre>
          ) : null}
        </section>
      </Modal>
    </li>
  )
}

/**
 * The skill center panel.
 * @param props - the slot's runtime share: the dictionary resolver and the workspace rows.
 * @returns the rendered panel.
 */
export function SkillCenterPage({
  t,
  renderSlot,
  ...runtime
}: PropsRuntime<'main'> & PropsRenderSlots<'skill-center.section'> & SkillCenterPageProps): ReactNode {
  const api = useMemo(() => new SkillApi(), [])
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [query, setQuery] = useState('')
  const [progress, setProgress] = useState<TranslationProgress | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ name: '', description: '', whenToUse: '', content: '', root: 'user' as 'user' | 'project' })
  // Sharing is DataOps state, fetched through the same-origin bridge. A 503
  // keeps every card local and disables publishing rather than inventing a
  // pending/approved status.
  const [plaza, setPlaza] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; records: Map<string, PlazaSkill> }
    | { kind: 'unavailable' }
    | { kind: 'failed'; message: string }
  >({ kind: 'loading' })
  const [shareTarget, setShareTarget] = useState<SkillEntry | null>(null)
  const [shareInstruction, setShareInstruction] = useState('')
  const [shareTags, setShareTags] = useState('')
  const [shareLoading, setShareLoading] = useState(false)
  const [shareBusy, setShareBusy] = useState(false)
  const [shareError, setShareError] = useState<string | null>(null)
  const [reviewScope, setReviewScope] = useState<ReviewScope | undefined>(undefined)
  const [departments, setDepartments] = useState<Department[]>([])
  const [shareVisibility, setShareVisibility] = useState<PlazaVisibility>('private')
  const [shareDepartment, setShareDepartment] = useState<string | undefined>(undefined)
  // `ui-workspace` publishes this seat through `slots.provideRoot`, so every root-scope
  // component receives it; the type is read from the runtime share rather than
  // hand-declared, because this package does not own the seat's declaration.
  const useWorkspaces = (runtime as { useWorkspaces?: WorkspaceSeat }).useWorkspaces
  const workspaces: readonly WorkspaceRow[] = useWorkspaces === undefined
    ? []
    : useWorkspaces(snapshot => snapshot.items)
  // A workspace holds its sessions, and the project skill roots are read relative to a
  // directory, so the panel scopes the listing to the workspace its sessions name. The
  // server process's own cwd would answer for the directory the server was started from.
  const scope = useMemo(() => {
    const withSessions = workspaces.find(item => item.sessionIds.length > 0)
    return (withSessions ?? workspaces[0])?.path
  }, [workspaces])

  const load = useCallback(async (): Promise<void> => {
    try {
      setState({ kind: 'ready', payload: await api.list(scope) })
    } catch (error) {
      setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }, [api, scope])

  const loadPlaza = useCallback(async (): Promise<void> => {
    try {
      const rows = await api.plazaMine()
      setPlaza({ kind: 'ready', records: new Map(rows.map(row => [row.name, row])) })
    } catch (error) {
      if (error instanceof PlazaUnavailableError) setPlaza({ kind: 'unavailable' })
      else setPlaza({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }, [api])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadPlaza() }, [loadPlaza])
  useEffect(() => {
    let cancelled = false
    void api.reviewContext()
      .then(async (scope) => {
        if (cancelled) return
        setReviewScope(scope)
        if (scope.canReviewGlobal === true) {
          const rows = await api.departments()
          if (!cancelled) setDepartments(rows)
        }
      })
      .catch(() => { /* No review context: private is the only safe option. */ })
    return () => { cancelled = true }
  }, [api])

  // Progress is read once per panel open: the translation script rewrites its record as it
  // advances, and reloading is what a user checking a running batch already does.
  useEffect(() => {
    let cancelled = false
    void api.translationProgress()
      .then((p) => { if (!cancelled) setProgress(p) })
      .catch(() => { /* Absent progress leaves the bar hidden; nothing else depends on it. */ })
    return () => { cancelled = true }
  }, [api])

  const plazaRecords = plaza.kind === 'ready' ? plaza.records : new Map<string, PlazaSkill>()
  const visibilityOptions = allowedVisibilities(reviewScope)
  const role = scopeRole(reviewScope)
  const ownCode = ownDepartment(reviewScope)
  const departmentChoices = role === 'admin' && departments.length > 0
    ? departments
    : (reviewScope?.departmentPath ?? []).filter(node => node.code !== '')
  const selectableDepartments = role === 'admin'
    ? departmentChoices
    : ownCode === undefined ? [] : [{ code: ownCode, name: departmentChoices.find(node => node.code === ownCode)?.name ?? ownCode }]
  const groups: Group[] = useMemo(() => {
    if (state.kind !== 'ready') return []
    const q = query.trim().toLowerCase()
    if (q === '') return state.payload.groups
    return state.payload.groups
      .map(g => ({
        ...g,
        // The card renders Chinese when a translation exists, so the search has to match
        // it; the English values stay searchable because the model still routes on them.
        skills: g.skills.filter(s =>
          s.name.toLowerCase().includes(q)
          || s.description.toLowerCase().includes(q)
          || (s.i18n?.title ?? '').toLowerCase().includes(q)
          || (s.i18n?.description ?? '').toLowerCase().includes(q)
          || (s.i18n?.summary ?? '').toLowerCase().includes(q)
          || (s.whenToUse ?? '').toLowerCase().includes(q)),
      }))
      .filter(g => g.skills.length > 0)
  }, [state, query])

  const toggle = useCallback(async (skill: SkillEntry, enabled: boolean): Promise<void> => {
    if (skill.path === undefined) return
    try {
      await api.setEnabled(skill.name, skill.path, enabled)
      await load()
    } catch (error) {
      setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }, [api, load])

  const remove = useCallback(async (skill: SkillEntry): Promise<void> => {
    if (skill.path === undefined) return
    if (!window.confirm(t('delete.confirm'))) return
    try {
      await api.remove(skill.name, skill.path)
      await load()
    } catch (error) {
      setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }, [api, load, t])

  const openShare = useCallback((skill: SkillEntry): void => {
    setShareTarget(skill)
    setShareInstruction('')
    setShareTags('')
    setShareError(null)
    const saved = readSavedScope(window.localStorage, scopeStorageKey(readAccountIdentity()))
    const choice = sanitizeChoice(saved, reviewScope, departments)
    setShareVisibility(choice.visibility)
    setShareDepartment(choice.departmentCode)
    setShareLoading(true)
    void api.content(skill.name, skill.path, scope)
      .then((payload) => { setShareInstruction(payload.content) })
      .catch((error: unknown) => { setShareError(t('plaza.failed') + ': ' + (error instanceof Error ? error.message : String(error))) })
      .finally(() => { setShareLoading(false) })
  }, [api, departments, reviewScope, scope, t])

  useEffect(() => {
    if (shareTarget === null || reviewScope === undefined) return
    const saved = readSavedScope(window.localStorage, scopeStorageKey(readAccountIdentity()))
    const choice = sanitizeChoice(saved, reviewScope, departments)
    setShareVisibility(choice.visibility)
    setShareDepartment(choice.departmentCode)
  }, [reviewScope, departments, shareTarget])

  const closeShare = useCallback((): void => {
    if (shareBusy) return
    setShareTarget(null)
    setShareError(null)
  }, [shareBusy])

  const submitShare = useCallback(async (): Promise<void> => {
    if (shareTarget === null) return
    if (shareInstruction.trim() === '') {
      setShareError(t('plaza.instruction') + ' required')
      return
    }
    setShareBusy(true)
    setShareError(null)
    try {
      const tags = shareTags.split(/[,，]/u).map(tag => tag.trim()).filter(tag => tag !== '')
      const choice = {
        visibility: shareVisibility,
        ...(shareVisibility === 'department' && shareDepartment !== undefined ? { departmentCode: shareDepartment } : {}),
      }
      await api.plazaSubmit({
        name: shareTarget.name,
        description: shareTarget.description,
        instruction: shareInstruction,
        ...(tags.length === 0 ? {} : { tags }),
        ...choice,
      })
      writeSavedScope(window.localStorage, scopeStorageKey(readAccountIdentity()), choice)
      setShareTarget(null)
      await loadPlaza()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (shareVisibility === 'global' && /403|forbidden|权限/i.test(message)) {
        const fallback = sanitizeChoice({ visibility: 'department' }, reviewScope, departments)
        setShareVisibility(fallback.visibility)
        setShareDepartment(fallback.departmentCode)
        setShareError(t('plaza.scopeForbidden'))
      } else {
        setShareError(error instanceof PlazaUnavailableError ? t('plaza.unavailable') : t('plaza.failed') + ': ' + message)
      }
    } finally {
      setShareBusy(false)
    }
  }, [api, departments, loadPlaza, reviewScope, shareDepartment, shareInstruction, shareTags, shareTarget, shareVisibility, t])

  const unshare = useCallback(async (_skill: SkillEntry, id: number): Promise<void> => {
    if (!window.confirm(t('plaza.unshareConfirm'))) return
    setShareBusy(true)
    setShareError(null)
    try {
      await api.plazaUnshare(id)
      await loadPlaza()
    } catch (error) {
      setShareError(error instanceof PlazaUnavailableError
        ? t('plaza.unavailable')
        : t('plaza.failed') + ': ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setShareBusy(false)
    }
  }, [api, loadPlaza, t])

  /** Bind one draft key to a change handler. */
  const set = useCallback((key: 'name' | 'description' | 'whenToUse' | 'content') =>
    (event: { target: { value: string } }): void => {
      const value = event.target.value
      setDraft(d => ({ ...d, [key]: value }))
    }, [])

  const submit = useCallback(async (): Promise<void> => {
    try {
      await api.create({
        root: draft.root,
        name: draft.name,
        description: draft.description,
        ...draft.whenToUse.trim() === '' ? {} : { whenToUse: draft.whenToUse },
        ...draft.content.trim() === '' ? {} : { content: draft.content },
      })
      setDraft({ name: '', description: '', whenToUse: '', content: '', root: 'user' })
      setCreating(false)
      await load()
    } catch (error) {
      setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }, [api, draft, load])

  const total = state.kind === 'ready' ? state.payload.groups.reduce((n, g) => n + g.skills.length, 0) : 0

  return (
    <div className={css.page}>
      <header className={css.pageHead}>
        <h1 className={css.pageTitle}>{t('panel')}</h1>
        <div className={css.toolbar}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('action.refresh')}
            title={t('action.refresh')}
            onClick={() => { void load() }}
          >
            <span className={css.iconWrap} aria-hidden="true"><IconRefreshOutlineRegular /></span>
          </button>
          <Button
            variant="primary"
            size="sm"
            icon={<IconPlusOutlineRegular size={13} />}
            onClick={() => { setCreating(v => !v) }}
          >
            {t('action.create')}
          </Button>
        </div>
      </header>

      <Modal
        open={creating}
        onClose={() => { setCreating(false) }}
        title={t('create.title')}
        closeLabel={t('action.cancel')}
        className={css.dialog as string}
        footer={(
          <>
            <Button variant="outline" autoFocus onClick={() => { setCreating(false) }}>
              {t('action.cancel')}
            </Button>
            <Button variant="primary" onClick={() => { void submit() }}>
              {t('action.confirm')}
            </Button>
          </>
        )}
      >
        <div className={css.form}>
          <DraftField label={t('create.name')}>
            <input className={css.input} value={draft.name} onChange={set('name')} />
          </DraftField>
          <DraftField label={t('create.description')}>
            <input className={css.input} value={draft.description} onChange={set('description')} />
          </DraftField>
          <DraftField label={t('create.whenToUse')}>
            <input className={css.input} value={draft.whenToUse} onChange={set('whenToUse')} />
          </DraftField>
          <DraftField label={t('create.content')}>
            <textarea className={css.textarea} value={draft.content} onChange={set('content')} />
          </DraftField>
          <DraftField label={t('create.root')}>
            <select className={css.input} value={draft.root} onChange={(e) => { setDraft(d => ({ ...d, root: e.target.value === 'project' ? 'project' : 'user' })) }}>
              <option value="user">{t('create.rootUser')}</option>
              <option value="project">{t('create.rootProject')}</option>
            </select>
          </DraftField>
        </div>
      </Modal>

      <Modal
        open={shareTarget !== null}
        onClose={closeShare}
        title={t('plaza.dialogTitle')}
        closeLabel={t('action.close')}
        className={css.dialog as string}
        footer={(
          <>
            <Button variant="outline" disabled={shareBusy} onClick={closeShare}>{t('action.cancel')}</Button>
            <Button variant="primary" disabled={shareBusy || shareLoading} onClick={() => { void submitShare() }}>{t('plaza.submit')}</Button>
          </>
        )}
      >
        {shareTarget === null ? null : (
          <div className={css.form} data-share-dialog={shareTarget.name}>
            <DraftField label={t('create.name')}>
              <input className={css.input} value={shareTarget.name} readOnly />
            </DraftField>
            <DraftField label={t('create.description')}>
              <input className={css.input} value={shareTarget.description} readOnly />
            </DraftField>
            <DraftField label={t('plaza.tags')}>
              <input className={css.input} value={shareTags} placeholder={t('plaza.tagsPlaceholder')} onChange={(event) => { setShareTags(event.target.value) }} />
            </DraftField>

            <DraftField label={t('plaza.visibility')}>
              <select
                className={css.input}
                value={shareVisibility}
                data-share-visibility
                onChange={(event) => {
                  const visibility = event.target.value as PlazaVisibility
                  setShareVisibility(visibility)
                  if (visibility === 'department') {
                    setShareDepartment(shareDepartment ?? ownCode ?? selectableDepartments[0]?.code)
                  }
                }}
              >
                {visibilityOptions.includes('global') ? <option value="global">{t('plaza.visibilityGlobal')}</option> : null}
                {visibilityOptions.includes('department') ? <option value="department">{t('plaza.visibilityDepartment')}</option> : null}
                <option value="private">{t('plaza.visibilityPrivate')}</option>
              </select>
            </DraftField>
            {shareVisibility === 'department' ? (
              <DraftField label={t('plaza.department')}>
                <select
                  className={css.input}
                  value={shareDepartment ?? selectableDepartments[0]?.code ?? ''}
                  data-share-department
                  disabled={role !== 'admin' || selectableDepartments.length <= 1}
                  onChange={(event) => { setShareDepartment(event.target.value) }}
                >
                  {selectableDepartments.map(department => (
                    <option key={department.code} value={department.code}>{department.name}</option>
                  ))}
                </select>
              </DraftField>
            ) : null}
            <div className={css.plazaScopeHint}>{role === 'admin' ? t('plaza.scopeHintAdmin') : t('plaza.scopeHintUser')}</div>
            <DraftField label={t('plaza.instruction')}>
              <textarea
                className={css.textarea}
                value={shareInstruction}
                readOnly={shareLoading}
                placeholder={shareLoading ? t('plaza.contentLoading') : undefined}
                onChange={(event) => { setShareInstruction(event.target.value) }}
              />
            </DraftField>
            {shareError === null ? null : <div className={css.status + ' ' + css.statusError} role="alert">{shareError}</div>}
          </div>
        )}
      </Modal>

      {plaza.kind === 'unavailable' ? (
        <div className={css.status} role="status" data-plaza-unavailable>{t('plaza.unavailable')}</div>
      ) : null}
      {shareError !== null && shareTarget === null ? (
        <div className={css.status + ' ' + css.statusError} role="alert">{shareError}</div>
      ) : null}

      {/* The shared input atom, so the box carries the panel's icon, radius, and
          focus ring rather than a second local control. */}
      <Input
        className={css.search as string}
        icon={<IconSearchOutlineRegular />}
        placeholder={t('search.placeholder')}
        aria-label={t('search.placeholder')}
        value={query}
        onChange={(e) => { setQuery(e.target.value) }}
      />

      {/* The bar reports a running batch; once every skill is indexed it has nothing
          left to say, so it leaves the header to the search field. */}
      {progress === undefined || progress.done >= progress.total ? null : (
        <div className={css.progressRow}>
          <span className={css.progressLabel}>{t('translate.label')}</span>
          <span className={css.progressTrack}>
            <span
              className={css.progressFill}
              style={{ width: String(progress.total === 0 ? 0 : Math.round(progress.done / progress.total * 100)) + '%' }}
            />
          </span>
          <span className={css.progressCount}>{progress.done} / {progress.total}</span>
        </div>
      )}

      {state.kind === 'loading' ? <div className={css.status}>{t('state.loading')}</div> : null}
      {state.kind === 'failed' ? <div className={css.status + ' ' + css.statusError}>{t('state.failed')}: {state.message}</div> : null}
      {state.kind === 'ready' && groups.length === 0 ? (
        <div className={css.status}>{query.trim() === '' ? t('state.empty') : t('search.noMatches')}</div>
      ) : null}
      {state.kind === 'ready' && groups.length > 0 && total === 0 ? (
        <div className={css.status}>{t('state.empty')}</div>
      ) : null}

      {groups.map(group => (
        <div className={css.group} key={group.key}>
          <h2 className={css.groupTitle}>
            {group.title}
            <span className={css.groupCount}>{group.skills.length}</span>
          </h2>
          <ul className={css.cards}>
            {group.skills.map(skill => (
              <SkillCard
                key={group.key + ':' + skill.name}
                skill={skill}
                api={api}
                cwd={state.kind === 'ready' ? state.payload.cwd : scope}
                t={t}
                share={shareOf(skill.name, plazaRecords)}
                shareBusy={shareBusy}
                shareDisabled={plaza.kind === 'unavailable'}
                onToggle={(s, enabled) => { void toggle(s, enabled) }}
                onDelete={(s) => { void remove(s) }}
                onShare={openShare}
                onUnshare={(s, id) => { void unshare(s, id) }}
              />
            ))}
          </ul>
        </div>
      ))}

      {renderSlot('skill-center.section', { query })}
    </div>
  )
}
