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
  IconSearchOutline16,
  IconSkillOutlineRegular,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slot-contract.ts'
import css from './SkillCenterPage.module.css'
import { SkillApi, type ListPayload, type SkillEntry, type TranslationProgress } from './api.ts'
import type { SkillCenterLocaleKey } from './locales.ts'

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
function SkillCard({ skill, api, cwd, t, onToggle, onDelete }: {
  skill: SkillEntry
  api: SkillApi
  cwd: string | undefined
  t: (key: SkillCenterLocaleKey) => string
  onToggle(skill: SkillEntry, enabled: boolean): void
  onDelete(skill: SkillEntry): void
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
  // What a user opens a card to read, in the order that answers "where does this come from and
  // when does it fire". A bundled skill has neither a when-to-use line nor a path — it ships
  // inside the runtime — so its level and provider are what the disclosure can state.
  const details: { key: SkillCenterLocaleKey; value: string }[] = []
  if (skill.whenToUse !== undefined) details.push({ key: 'detail.whenToUse', value: skill.whenToUse })
  details.push({ key: 'detail.source', value: skill.level })
  if (skill.provider !== undefined) details.push({ key: 'detail.provider', value: skill.provider })
  if (skill.path !== undefined) details.push({ key: 'detail.path', value: skill.path })
  return (
    <li className={foreign ? css.card + ' ' + css.cardForeign : css.card}>
      <div className={css.cardHead}>
        <span className={css.cardIcon}><IconSkillOutlineRegular size={16} /></span>
        <div className={css.cardTitleRow}>
          <div className={css.cardTitle}>{skill.i18n?.title ?? skill.name}</div>
          {skill.workspaceName === undefined ? null : (
            <span className={css.workspaceBadge}>{skill.workspaceName}</span>
          )}
        </div>
      </div>
      <div className={css.cardBody}>
        {/* One line of copy on a card: the summary a translation carries, and the
            registry description when there is no translation to summarize. */}
        <div className={css.cardSummary}>{skill.i18n?.summary ?? skill.description}</div>
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

  useEffect(() => { void load() }, [load])

  // Progress is read once per panel open: the translation script rewrites its record as it
  // advances, and reloading is what a user checking a running batch already does.
  useEffect(() => {
    let cancelled = false
    void api.translationProgress()
      .then((p) => { if (!cancelled) setProgress(p) })
      .catch(() => { /* Absent progress leaves the bar hidden; nothing else depends on it. */ })
    return () => { cancelled = true }
  }, [api])

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

      {/* The shared input atom, so the box carries the panel's icon, radius, and
          focus ring rather than a second local control. */}
      <Input
        className={css.search as string}
        icon={<IconSearchOutline16 />}
        placeholder={t('search.placeholder')}
        aria-label={t('search.placeholder')}
        value={query}
        onChange={(e) => { setQuery(e.target.value) }}
      />

      {progress === undefined ? null : (
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
                onToggle={(s, enabled) => { void toggle(s, enabled) }}
                onDelete={(s) => { void remove(s) }}
              />
            ))}
          </ul>
        </div>
      ))}

      {renderSlot('skill-center.section', { query })}
    </div>
  )
}
