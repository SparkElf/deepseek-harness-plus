/** Plugin configuration card for the existing continuous and one-shot delegation entries. */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { Button, IconChevronDownOutline14, Input, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PluginsSettingsLocaleKey } from './locales.ts'
import type { SubagentEntryView, SubagentModelChoice, SubagentSettingsState, SubagentSettingsValue } from './subagent-store.ts'
import { PluginCard } from './PluginCard.tsx'
import css from './SubagentCard.module.css'

/** Browser-side actions and snapshot supplied by the plugin-slot registration. */
export interface SubagentCardInjected {
  hooks: { subagentSettings: SnapshotStore<SubagentSettingsState> }
  load: () => Promise<void>
  stage: (entry: SubagentEntryView, value: SubagentSettingsValue) => void
  save: () => Promise<void>
  reset: (entry: SubagentEntryView) => void
  discard: () => void
}

/** Props for the subagent plugin configuration card. */
export type SubagentCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<SubagentCardInjected>

function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _omitted, ...rest } = value
  return rest
}

function namesOf(filter: SubagentSettingsValue['toolFilter']): string {
  return (filter?.allow ?? filter?.deny ?? []).join(', ')
}

interface EntryEditorProps {
  entry: SubagentEntryView
  value: SubagentSettingsValue
  models: readonly SubagentModelChoice[]
  writable: boolean
  saving: boolean
  t: (key: PluginsSettingsLocaleKey) => string
  onChange: (value: SubagentSettingsValue) => void
  onReset: () => void
}

function EntryEditor({ entry, value: draft, models, writable, saving, t, onChange, onReset }: EntryEditorProps): ReactNode {
  const [depthMenuOpen, setDepthMenuOpen] = useState(false)
  const setDraft = (update: (current: SubagentSettingsValue) => SubagentSettingsValue): void => { onChange(update(draft)) }
  const fixedModel = draft.agentOptions?.provider !== undefined || draft.agentOptions?.model !== undefined
  const toolMode = draft.toolFilter?.allow !== undefined ? 'allow' : draft.toolFilter?.deny !== undefined ? 'deny' : 'all'
  const modelSuggestions = useMemo(
    () => models.filter(model => model.provider === draft.agentOptions?.provider),
    [models, draft.agentOptions?.provider],
  )
  const depthId = draft.maxDepth === 'provider-managed' ? 'provider-managed' : String(draft.maxDepth ?? 3)
  const depthItems = useMemo(() => [0, 1, 2, 3, 4, 5].map(value => ({ id: String(value), label: String(value) })).concat({ id: 'provider-managed', label: t('subagentProviderManaged') }), [t])
  const setOptions = (change: Partial<NonNullable<SubagentSettingsValue['agentOptions']>>): void => {
    setDraft(current => ({ ...current, agentOptions: { ...current.agentOptions, ...change } }))
  }
  const followParent = (): void => {
    setDraft((current) => {
      const maxTokens = current.agentOptions?.maxTokens
      if (maxTokens === undefined) return without(current, 'agentOptions')
      return { ...current, agentOptions: { maxTokens } }
    })
  }
  const clearMaxTokens = (): void => {
    setDraft((current) => {
      const provider = current.agentOptions?.provider
      const model = current.agentOptions?.model
      if (provider === undefined && model === undefined) return without(current, 'agentOptions')
      return {
        ...current,
        agentOptions: {
          ...provider === undefined ? {} : { provider },
          ...model === undefined ? {} : { model },
        },
      }
    })
  }
  const setToolMode = (mode: 'all' | 'allow' | 'deny'): void => {
    setDraft((current) => {
      if (mode === 'all') return without(current, 'toolFilter')
      return mode === 'allow'
        ? { ...current, toolFilter: { allow: [] } }
        : { ...current, toolFilter: { deny: [] } }
    })
  }
  const setToolNames = (text: string): void => {
    const names = text.split(',').map(name => name.trim()).filter(Boolean)
    setDraft((current) => {
      if (toolMode === 'allow') return { ...current, toolFilter: { allow: names } }
      if (toolMode === 'deny') return { ...current, toolFilter: { deny: names } }
      return current
    })
  }
  return (
    <div className={css.editor}>
      <section className={css.group}>
        <h3>{t('subagentModel')}</h3>
        <label className={css.radioRow}><input type="radio" checked={!fixedModel} disabled={!writable || saving} onChange={followParent} />{t('subagentFollowParent')}</label>
        <label className={css.radioRow}><input type="radio" checked={fixedModel} disabled={!writable || saving} onChange={() => { setOptions({ provider: draft.agentOptions?.provider ?? '', model: draft.agentOptions?.model ?? '' }) }} />{t('subagentFixedModel')}</label>
        {fixedModel && <>
          <label className={css.field}>{t('subagentProvider')}<Input className={css.control as string} value={draft.agentOptions?.provider ?? ''} disabled={!writable || saving} onChange={(event) => { setOptions({ provider: event.target.value }) }} /></label>
          <label className={css.field}>{t('subagentModelId')}<Input className={css.control as string} list={'subagent-models-' + entry.ns} value={draft.agentOptions?.model ?? ''} disabled={!writable || saving} onChange={(event) => { setOptions({ model: event.target.value }) }} /><datalist id={'subagent-models-' + entry.ns}>{modelSuggestions.map(model => <option key={model.key} value={model.model}>{model.providerName + ' · ' + model.modelName}</option>)}</datalist></label>
        </>}
        <label className={css.field}>{t('subagentMaxTokens')}<Input className={css.control as string} type="number" min="1" step="1" value={draft.agentOptions?.maxTokens ?? ''} disabled={!writable || saving} onChange={(event) => { if (event.target.value === '') clearMaxTokens(); else setOptions({ maxTokens: Number(event.target.value) }) }} /></label>
      </section>
      <section className={css.group}>
        <h3>{t('subagentPersona')}</h3>
        <label className={css.radioRow}><input type="radio" checked={draft.persona === undefined} disabled={!writable || saving} onChange={() => { setDraft(current => without(current, 'persona')) }} />{t('subagentInheritPersona')}</label>
        <label className={css.radioRow}><input type="radio" checked={draft.persona !== undefined} disabled={!writable || saving} onChange={() => { setDraft(current => ({ ...current, persona: current.persona ?? '' })) }} />{t('subagentOverridePersona')}</label>
        {draft.persona !== undefined && <textarea aria-label={t('subagentPersona')} className={css.textarea} value={draft.persona} disabled={!writable || saving} placeholder={t('subagentPersonaPlaceholder')} onChange={(event) => { setDraft(current => ({ ...current, persona: event.target.value })) }} />}
      </section>
      <section className={css.group}>
        <h3>{t('subagentTools')}</h3>
        <label className={css.radioRow}><input type="radio" checked={toolMode === 'all'} disabled={!writable || saving} onChange={() => { setToolMode('all') }} />{t('subagentAllTools')}</label>
        <label className={css.radioRow}><input type="radio" checked={toolMode === 'allow'} disabled={!writable || saving} onChange={() => { setToolMode('allow') }} />{t('subagentAllowTools')}</label>
        <label className={css.radioRow}><input type="radio" checked={toolMode === 'deny'} disabled={!writable || saving} onChange={() => { setToolMode('deny') }} />{t('subagentDenyTools')}</label>
        {toolMode !== 'all' && <Input className={css.control as string} aria-label={t('subagentTools')} value={namesOf(draft.toolFilter)} disabled={!writable || saving} placeholder={t('subagentToolNamesPlaceholder')} onChange={(event) => { setToolNames(event.target.value) }} />}
      </section>
      <section className={css.group}>
        <label className={css.field}>{t('subagentDepth')}
          <Menu open={depthMenuOpen} anchor={<button type="button" className={css.select} aria-label={t('subagentDepth')} aria-haspopup="menu" aria-expanded={depthMenuOpen} onClick={() => { setDepthMenuOpen(current => !current) }}>{depthItems.find(item => item.id === depthId)?.label ?? depthId}<IconChevronDownOutline14 /></button>} items={depthItems} selectedId={depthId} onSelect={(id) => { setDepthMenuOpen(false); setDraft(current => ({ ...current, maxDepth: id === 'provider-managed' ? 'provider-managed' : Number(id) })) }} onClose={() => { setDepthMenuOpen(false) }} dense />
        </label>
      </section>
      <div className={css.actions}>
        <Button variant="outline" size="sm" disabled={!writable || saving} onClick={onReset}>{t('reset')}</Button>
      </div>
    </div>
  )
}

/** Render the subagent controls inside the shared plugin-card chrome. */
export function SubagentCard(props: SubagentCardProps): ReactNode {
  const { useSubagentSettings, t, load } = props
  const state = useSubagentSettings(snapshot => snapshot)
  useEffect(() => { void load() }, [load])
  const cardState = {
    available: true,
    writable: state.writable,
    dirty: Object.keys(state.drafts).length > 0,
    invalid: false,
    saving: state.saving,
    failed: state.saveError !== null,
  }
  return (
    <PluginCard
      t={t}
      titleKey="subagentTitle"
      descriptionKey="subagentDescription"
      state={cardState}
      onSave={() => { void props.save() }}
      onDiscard={props.discard}
    >
      {state.status === 'loading' && <p className={css.status}>{t('subagentLoading')}</p>}
      {state.status === 'error' && <div role="alert" className={css.error}>
        {state.error ?? t('subagentLoadFailed')}
        <Button size="sm" onClick={() => { void load() }}>{t('subagentRetry')}</Button>
      </div>}
      {state.status === 'ready' && <div className={css.entries}>
        {state.entries.map(entry => <section className={css.entry} key={entry.ns}>
          <h3 className={css.entryTitle}>{t(entry.label as PluginsSettingsLocaleKey)}</h3>
          <EntryEditor
            entry={entry}
            value={state.drafts[entry.ns] ?? entry.value}
            models={state.models}
            writable={state.writable}
            saving={state.saving}
            t={t}
            onChange={(value) => { props.stage(entry, value) }}
            onReset={() => { props.reset(entry) }}
          />
        </section>)}
      </div>}
    </PluginCard>
  )
}
