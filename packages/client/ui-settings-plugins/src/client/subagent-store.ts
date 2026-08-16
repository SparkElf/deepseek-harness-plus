/** Host-backed staged state for the two shipped subagent plugin configuration entries. */
import type { IApiClient, ModelProviderGroup, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** One editable value from a tool-subagent settings namespace. */
export interface SubagentSettingsValue {
  agentOptions?: Partial<{ provider: string; model: string; maxTokens: number }>
  persona?: string
  toolFilter?: { allow?: string[]; deny?: string[] }
  maxDepth?: number | 'provider-managed'
}

/** One shipped delegation entry and its effective settings. */
export interface SubagentEntryView {
  ns: string
  kind: 'spawn' | 'fork'
  label: string
  context: 'fresh' | 'forked'
  background: 'continuable' | 'one-shot'
  value: SubagentSettingsValue
  revision: number
  applies: 'live' | 'restart'
}

/** A model choice used by the child model selector. */
export interface SubagentModelChoice {
  key: string
  provider: string
  providerName: string
  model: string
  modelName: string
}

/** State rendered by the shared plugin card. */
export interface SubagentSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  writable: boolean
  entries: readonly SubagentEntryView[]
  models: readonly SubagentModelChoice[]
  drafts: Readonly<Record<string, SubagentSettingsValue>>
  saving: boolean
  saveError: string | null
}

const ENTRY_META: Record<string, Omit<SubagentEntryView, 'ns' | 'value' | 'revision' | 'applies'>> = {
  subagent: { kind: 'spawn', label: 'subagentContinuous', context: 'fresh', background: 'continuable' },
  'subagent-fork': { kind: 'fork', label: 'subagentOneShot', context: 'forked', background: 'one-shot' },
}

function objectOf(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('settings ' + path + ' is not an object')
  return value as Record<string, unknown>
}

function stringOf(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error('settings ' + path + ' is not a string')
  return value
}

function stringsOf(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error('settings ' + path + ' is not a string array')
  return value.map((item, index) => stringOf(item, path + '[' + String(index) + ']'))
}

function parseValue(value: unknown, ns: string): SubagentSettingsValue {
  const root = objectOf(value, ns)
  const rawOptions = root.agentOptions
  const rawFilter = root.toolFilter
  const agentOptions = rawOptions === undefined ? undefined : objectOf(rawOptions, ns + '.agentOptions')
  const toolFilter = rawFilter === undefined ? undefined : objectOf(rawFilter, ns + '.toolFilter')
  const maxTokens = agentOptions?.maxTokens
  if (maxTokens !== undefined && (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens < 1)) throw new Error('settings ' + ns + '.agentOptions.maxTokens is invalid')
  const maxDepth = root.maxDepth
  if (maxDepth !== undefined && maxDepth !== 'provider-managed' && (typeof maxDepth !== 'number' || !Number.isSafeInteger(maxDepth) || maxDepth < 0)) throw new Error('settings ' + ns + '.maxDepth is invalid')
  return {
    ...agentOptions === undefined ? {} : {
      agentOptions: {
        ...agentOptions.provider === undefined ? {} : { provider: stringOf(agentOptions.provider, ns + '.agentOptions.provider') },
        ...agentOptions.model === undefined ? {} : { model: stringOf(agentOptions.model, ns + '.agentOptions.model') },
        ...maxTokens === undefined ? {} : { maxTokens: maxTokens },
      },
    },
    ...root.persona === undefined ? {} : { persona: stringOf(root.persona, ns + '.persona') },
    ...toolFilter === undefined ? {} : {
      toolFilter: {
        ...toolFilter.allow === undefined ? {} : { allow: stringsOf(toolFilter.allow, ns + '.toolFilter.allow') },
        ...toolFilter.deny === undefined ? {} : { deny: stringsOf(toolFilter.deny, ns + '.toolFilter.deny') },
      },
    },
    ...maxDepth === undefined ? {} : { maxDepth: maxDepth },
  }
}

function choicesOf(groups: readonly ModelProviderGroup[]): SubagentModelChoice[] {
  return groups.flatMap(group => group.models.map(model => ({
    key: group.id + '::' + model.id,
    provider: group.id,
    providerName: group.name,
    model: model.id,
    modelName: model.name,
  })))
}

/** Settings controller used by the shared plugin card. */
export class SubagentSettingsStore {
  /** Reactive state shared by the settings section. */
  readonly store: SnapshotStore<SubagentSettingsState> = createSnapshotStore({
    status: 'idle', error: null, writable: false, entries: [], models: [], drafts: {}, saving: false, saveError: null,
  })
  private generation = 0

  constructor(private readonly api: Pick<IApiClient, 'settings' | 'llm'>) {}

  /** Reload effective child defaults; model choices load independently. */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => { state.status = 'loading'; state.error = null })
    try {
      const response = await this.api.settings.describe({})
      const result = response.result
      if (!result.ok) throw new Error(result.error.message)
      const entries = result.value.namespaces
        .filter(view => ENTRY_META[view.ns] !== undefined)
        .map(view => this.entryOf(view))
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'ready'
        state.writable = result.value.writable
        state.entries = entries
      })
      void this.loadModelChoices(generation)
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((state) => { state.status = 'error'; state.error = error instanceof Error ? error.message : String(error) })
    }
  }

  /** Add advertised model choices when the optional catalog request settles. */
  private async loadModelChoices(generation: number): Promise<void> {
    const response = await this.api.llm.models({})
    const result = response.result
    if (!result.ok || generation !== this.generation) return
    const models = choicesOf(result.value.groups)
    this.store.update((state) => { state.models = models })
  }

  /** Stage one entry until the shared plugin card is saved.
   * @param entry - Entry being edited.
   * @param value - Complete staged user section.
   */
  stage(entry: SubagentEntryView, value: SubagentSettingsValue): void {
    this.store.update((state) => { state.drafts = { ...state.drafts, [entry.ns]: value } })
  }

  /** Persist every staged entry with its descriptor revision guard. */
  async save(): Promise<void> {
    const snapshot = this.store.getSnapshot()
    const staged = snapshot.drafts
    if (Object.keys(staged).length === 0) return
    this.store.update((state) => { state.saving = true; state.saveError = null })
    try {
      for (const entry of snapshot.entries) {
        const value = staged[entry.ns]
        if (value === undefined) continue
        const response = await this.api.settings.replace({ ns: entry.ns, section: value, expectedRevision: entry.revision })
        if (!response.result.ok) throw new Error(response.result.error.message)
      }
      this.store.update((state) => { state.drafts = {} })
      await this.load()
    } catch (error) {
      this.store.update((state) => { state.saveError = error instanceof Error ? error.message : String(error) })
    } finally {
      this.store.update((state) => { state.saving = false })
    }
  }

  /** Stage one entry back to its deployment defaults.
   * @param entry - Entry being reset.
   */
  reset(entry: SubagentEntryView): void { this.stage(entry, {}) }

  /** Discard all staged edits without writing them. */
  discard(): void {
    this.store.update((state) => { state.drafts = {}; state.saveError = null })
  }

  private entryOf(view: SettingsNamespaceView): SubagentEntryView {
    const meta = ENTRY_META[view.ns]
    if (meta === undefined) throw new Error('unknown subagent settings namespace ' + view.ns)
    return { ns: view.ns, ...meta, value: parseValue(view.value, view.ns), revision: view.revision, applies: view.applies }
  }
}
