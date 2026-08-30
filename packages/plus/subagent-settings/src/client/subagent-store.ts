/** Shared Settings-scope state for the unified subagent settings section. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'

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

/** State rendered by the unified settings section. */
export interface SubagentSettingsState {
  writable: boolean
  entries: readonly SubagentEntryView[]
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
type SettingsMutation = Parameters<SettingsScope<SubagentSettingsValue>['mutate']>[0]

function replacementOperations(value: SubagentSettingsValue): SettingsMutation {
  const agentOptions: Record<string, string | number> = {}
  if (value.agentOptions?.provider !== undefined) agentOptions.provider = value.agentOptions.provider
  if (value.agentOptions?.model !== undefined) agentOptions.model = value.agentOptions.model
  if (value.agentOptions?.maxTokens !== undefined) agentOptions.maxTokens = value.agentOptions.maxTokens
  const toolFilter: Record<string, string[]> = {}
  if (value.toolFilter?.allow !== undefined) toolFilter.allow = value.toolFilter.allow
  if (value.toolFilter?.deny !== undefined) toolFilter.deny = value.toolFilter.deny
  return [
    value.enabled === undefined ? { op: 'unset', path: ['enabled'] } : { op: 'set', path: ['enabled'], value: value.enabled },
    value.agentOptions === undefined ? { op: 'unset', path: ['agentOptions'] } : { op: 'set', path: ['agentOptions'], value: agentOptions },
    value.persona === undefined ? { op: 'unset', path: ['persona'] } : { op: 'set', path: ['persona'], value: value.persona },
    value.toolFilter === undefined ? { op: 'unset', path: ['toolFilter'] } : { op: 'set', path: ['toolFilter'], value: toolFilter },
    value.maxDepth === undefined ? { op: 'unset', path: ['maxDepth'] } : { op: 'set', path: ['maxDepth'], value: value.maxDepth },
  ]
}

function withoutNamespace<T>(
  record: Readonly<Partial<Record<SubagentSettingsNamespace, T>>>,
  namespace: SubagentSettingsNamespace,
): Partial<Record<SubagentSettingsNamespace, T>> {
  const { [namespace]: _removed, ...remaining } = record
  return remaining
}

/** Settings controller shared by both mode panels. */
export class SubagentSettingsStore {
  /** Reactive state shared by both mode panels. */
  readonly store: SnapshotStore<SubagentSettingsState> = createSnapshotStore({
    writable: false, entries: [], drafts: {}, saving: false, saveErrors: {},
  })
  private readonly unsubscribers: (() => void)[] = []
  private started = false

  /**
   * @param scopes - namespace scopes derived from the browser's shared Settings mirror.
   */
  constructor(private readonly scopes: SubagentScopes) {}

  /** Start following both scopes and load model choices once. */
  ensure(): void {
    if (this.started) return
    this.started = true
    for (const ns of SUBAGENT_NAMESPACES) {
      this.unsubscribers.push(this.scopes[ns].subscribe(() => { this.derive() }))
    }
    this.derive()
  }

  /** Stop following the two Settings scopes. */
  dispose(): void {
    this.started = false
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
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
    try {
      await this.scopes[entry.ns].mutate(replacementOperations(value))
      this.store.update((state) => { state.drafts = withoutNamespace(state.drafts, entry.ns) })
    } catch (_settingsWriteFailure) {
      this.store.update((state) => { state.saveErrors = { ...state.saveErrors, [entry.ns]: true } })
    } finally {
      this.store.update((state) => { state.saving = false })
    }
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
}
