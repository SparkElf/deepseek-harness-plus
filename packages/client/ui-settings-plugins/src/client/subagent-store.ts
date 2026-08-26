/** Shared Settings-scope state for the unified subagent settings section. */
import type { IApiClient, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** One editable value from a tool-subagent settings namespace. */
export interface SubagentSettingsValue {
  enabled?: boolean
  agentOptions?: Partial<{ provider: string; model: string; maxTokens: number }>
  persona?: string
  toolFilter?: { allow?: string[]; deny?: string[] }
  maxDepth?: number | 'provider-managed'
}

/** Settings namespaces owned by the two shipped delegation entries. */
export type SubagentSettingsNamespace = 'subagent' | 'subagent-fork'

/** One shipped delegation entry and its effective settings. */
export interface SubagentEntryView {
  ns: SubagentSettingsNamespace
  kind: 'spawn' | 'fork'
  label: string
  context: 'fresh' | 'forked'
  background: 'continuable' | 'one-shot'
  value: SubagentSettingsValue
}

/** A model choice used by the child model selector. */
export interface SubagentModelChoice {
  key: string
  provider: string
  providerName: string
  model: string
  modelName: string
}

/** State rendered by the unified settings section. */
export interface SubagentSettingsState {
  writable: boolean
  entries: readonly SubagentEntryView[]
  models: readonly SubagentModelChoice[]
  drafts: Readonly<Partial<Record<SubagentSettingsNamespace, SubagentSettingsValue>>>
  saving: boolean
  saveErrors: Readonly<Partial<Record<SubagentSettingsNamespace, true>>>
}

const SUBAGENT_NAMESPACES = ['subagent', 'subagent-fork'] as const

const ENTRY_META: Record<SubagentSettingsNamespace, Omit<SubagentEntryView, 'ns' | 'value'>> = {
  subagent: { kind: 'spawn', label: 'subagentContinuous', context: 'fresh', background: 'continuable' },
  'subagent-fork': { kind: 'fork', label: 'subagentOneShot', context: 'forked', background: 'one-shot' },
}

type SubagentScopes = Record<SubagentSettingsNamespace, SettingsScope<SubagentSettingsValue>>

function withoutNamespace<T>(
  record: Readonly<Partial<Record<SubagentSettingsNamespace, T>>>,
  namespace: SubagentSettingsNamespace,
): Partial<Record<SubagentSettingsNamespace, T>> {
  const { [namespace]: _removed, ...remaining } = record
  return remaining
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

/** Settings controller shared by both mode panels. */
export class SubagentSettingsStore {
  /** Reactive state shared by both mode panels. */
  readonly store: SnapshotStore<SubagentSettingsState> = createSnapshotStore({
    writable: false, entries: [], models: [], drafts: {}, saving: false, saveErrors: {},
  })
  private readonly unsubscribers: (() => void)[] = []
  private modelGeneration = 0
  private started = false

  /**
   * @param scopes - namespace scopes derived from the browser's shared Settings mirror.
   * @param api - model catalog wire face.
   */
  constructor(
    private readonly scopes: SubagentScopes,
    private readonly api: Pick<IApiClient, 'llm'>,
  ) {}

  /** Start following both scopes and load model choices once. */
  ensure(): void {
    if (this.started) return
    this.started = true
    for (const ns of SUBAGENT_NAMESPACES) {
      this.unsubscribers.push(this.scopes[ns].subscribe(() => { this.derive() }))
    }
    this.derive()
    this.refreshModels()
  }

  /** Stop following the two Settings scopes. */
  dispose(): void {
    this.started = false
    this.modelGeneration += 1
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
  }

  /** Reload model choices after model-adapter topology changes or reconnects. */
  refreshModels(): void {
    if (!this.started) return
    const generation = ++this.modelGeneration
    void this.loadModelChoices(generation)
  }

  /** Stage one entry until its plugin card is saved.
   * @param entry - entry being edited.
   * @param value - complete staged user section.
   */
  stage(entry: SubagentEntryView, value: SubagentSettingsValue): void {
    this.store.update((state) => { state.drafts = { ...state.drafts, [entry.ns]: value } })
  }

  /** Persist one staged entry through its Settings scope.
   * @param entry - entry whose card initiated the save.
   */
  async save(entry: SubagentEntryView): Promise<void> {
    const value = this.store.getSnapshot().drafts[entry.ns]
    if (value === undefined) return
    this.store.update((state) => {
      state.saving = true
      state.saveErrors = withoutNamespace(state.saveErrors, entry.ns)
    })
    const committed = await this.scopes[entry.ns].replace(value)
    this.store.update((state) => {
      if (committed) {
        state.drafts = withoutNamespace(state.drafts, entry.ns)
      } else {
        state.saveErrors = { ...state.saveErrors, [entry.ns]: true }
      }
      state.saving = false
    })
  }

  /** Stage one entry back to its deployment defaults.
   * @param entry - entry being reset.
   */
  reset(entry: SubagentEntryView): void { this.stage(entry, {}) }

  /** Discard one card's staged edit without writing it.
   * @param entry - entry whose draft is discarded.
   */
  discard(entry: SubagentEntryView): void {
    this.store.update((state) => {
      state.drafts = withoutNamespace(state.drafts, entry.ns)
      state.saveErrors = withoutNamespace(state.saveErrors, entry.ns)
    })
  }

  private derive(): void {
    const entries = SUBAGENT_NAMESPACES.flatMap((ns): SubagentEntryView[] => {
      const snapshot = this.scopes[ns].getSnapshot()
      if (snapshot.status !== 'ready') return []
      return [{ ns, ...ENTRY_META[ns], value: snapshot.value as SubagentSettingsValue }]
    })
    const writable = entries.length > 0 && entries.every(entry => this.scopes[entry.ns].getSnapshot().writable)
    this.store.update((state) => {
      state.entries = entries
      state.writable = writable
    })
  }

  private async loadModelChoices(generation: number): Promise<void> {
    let response: Awaited<ReturnType<IApiClient['llm']['models']>>
    try {
      response = await this.api.llm.models({})
    } catch (_modelCatalogReadFailure) {
      return
    }
    if (!response.result.ok || generation !== this.modelGeneration) return
    const models = choicesOf(response.result.value.groups)
    this.store.update((state) => { state.models = models })
  }
}
