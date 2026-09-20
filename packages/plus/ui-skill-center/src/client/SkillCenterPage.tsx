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
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSkillOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SkillCenterPage.module.css'
import { SkillApi, type ListPayload, type SkillEntry } from './api.ts'
import type { SkillCenterLocaleKey } from './locales.ts'

/** What the panel needs from its slot: the dictionary resolver. */
export interface SkillCenterPageProps {
  t(key: SkillCenterLocaleKey): string
}

/** Client-side group shape, as the list route serves it. */
interface Group {
  key: string
  title: string
  hint: string
  skills: SkillEntry[]
}

/** How the panel is currently showing the list. */
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; payload: ListPayload }
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
 * One skill row.
 * @param props - the entry, its toggle, and its delete action.
 * @returns the row.
 */
function SkillCard({ skill, t, onToggle, onDelete }: {
  skill: SkillEntry
  t: (key: SkillCenterLocaleKey) => string
  onToggle(skill: SkillEntry, enabled: boolean): void
  onDelete(skill: SkillEntry): void
}): ReactNode {
  return (
    <li className={css.card}>
      <div className={css.cardHead}>
        <span className={css.cardIcon}><IconSkillOutline16 size={22} /></span>
        <div className={css.cardMain}>
          <div className={css.cardTitle}>{skill.name}</div>
          <div className={css.cardDesc}>{skill.description}</div>
          {skill.whenToUse === undefined ? null : (
            <div className={css.cardWhenToUse}>{skill.whenToUse}</div>
          )}
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
          {skill.path === undefined || skill.linked === true ? null : (
            <button type="button" className={css.button} onClick={() => { onDelete(skill) }}>
              {t('action.delete')}
            </button>
          )}
        </div>
      </div>
    </li>
  )
}

/**
 * The skill center panel.
 * @param props - the slot's runtime share, providing the dictionary resolver.
 * @returns the rendered panel.
 */
export function SkillCenterPage({ t }: PropsRuntime<'main'> & SkillCenterPageProps): ReactNode {
  const api = useMemo(() => new SkillApi(), [])
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ name: '', description: '', whenToUse: '', content: '', root: 'user' as 'user' | 'project' })

  const load = useCallback(async (): Promise<void> => {
    try {
      setState({ kind: 'ready', payload: await api.list() })
    } catch (error) {
      setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  const groups: Group[] = useMemo(() => {
    if (state.kind !== 'ready') return []
    const q = query.trim().toLowerCase()
    if (q === '') return state.payload.groups
    return state.payload.groups
      .map(g => ({
        ...g,
        skills: g.skills.filter(s =>
          s.name.toLowerCase().includes(q)
          || s.description.toLowerCase().includes(q)
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
        <div>
          <h1 className={css.pageTitle}>{t('panel')}</h1>
          <p className={css.pageIntro}>{t('panel.intro')}</p>
        </div>
        <div className={css.toolbar}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('action.refresh')}
            title={t('action.refresh')}
            onClick={() => { void load() }}
          >
            <span className={css.iconWrap} aria-hidden="true"><IconRefreshOutline16 /></span>
          </button>
          <Button
            variant="primary"
            size="sm"
            icon={<IconPlusOutline16 size={13} />}
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

      <input
        className={css.search}
        placeholder={t('search.placeholder')}
        value={query}
        onChange={(e) => { setQuery(e.target.value) }}
      />

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
            <span className={css.groupHint}>{group.hint}</span>
          </h2>
          <ul className={css.cards}>
            {group.skills.map(skill => (
              <SkillCard
                key={group.key + ':' + skill.name}
                skill={skill}
                t={t}
                onToggle={(s, enabled) => { void toggle(s, enabled) }}
                onDelete={(s) => { void remove(s) }}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
