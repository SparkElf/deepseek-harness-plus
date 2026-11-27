/**
 * Model choices for the workflow subscription dialog.
 *
 * The Host owns the catalog (`remote.session.modelCatalog()`); this module only narrows
 * it for rendering and remembers the reader's last pick. Keeping the mapping pure makes
 * the "catalog unavailable" fallback testable without a browser or a Host.
 *
 * @module @sparkelf/dsh-knowledge-base/client/workflows/modelChoice
 */

/** One exact model route the Host can serve. */
export interface WorkflowModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One reasoning level an adapter exposes for a model. */
export interface WorkflowReasoningEffort {
  readonly id: string
  readonly name: string
}

/** One model row rendered inside its provider group. */
export interface WorkflowModelOption extends WorkflowModelSelection {
  /** Stable `<optgroup>`/`<option>` key: provider + model. */
  readonly key: string
  readonly providerName: string
  readonly modelName: string
  readonly description?: string
  readonly reasoningEfforts: readonly WorkflowReasoningEffort[]
  /** The effort the Host would use when none is chosen. */
  readonly defaultEffort?: string
}

/** One provider group. */
export interface WorkflowModelGroup {
  readonly provider: string
  readonly providerName: string
  readonly models: readonly WorkflowModelOption[]
}

/** The catalog as the dialog consumes it. */
export interface WorkflowModelCatalogView {
  readonly default?: WorkflowModelSelection
  readonly groups: readonly WorkflowModelGroup[]
  /** Providers whose catalog could not be loaded; shown as a quiet fallback note. */
  readonly failures: readonly { readonly provider: string; readonly message: string }[]
}

/** The raw shape `remote.session.modelCatalog()` returns (narrowed structurally). */
export interface RawModelCatalog {
  readonly default?: WorkflowModelSelection
  readonly groups?: readonly {
    readonly id: string
    readonly name: string
    readonly models: readonly {
      readonly id: string
      readonly name: string
      readonly description?: string
      readonly reasoning?: {
        readonly efforts: readonly WorkflowReasoningEffort[]
        readonly defaultEffort?: string
      }
    }[]
  }[]
  readonly failures?: readonly { readonly id: string; readonly name: string; readonly message: string }[]
}

/** The localStorage key; per browser profile, which is the DSH workspace's boundary. */
export const WORKFLOW_MODEL_STORAGE_KEY = 'dsh-kb-workflow-model'

/** Stable key for one provider/model pair. */
export const modelKeyOf = (selection: WorkflowModelSelection): string => (
  selection.provider + '\u0000' + selection.model
)

/** Narrow a Host catalog into renderable groups. */
export function toWorkflowModelCatalog(raw: RawModelCatalog | undefined): WorkflowModelCatalogView {
  if (raw === undefined) return { groups: [], failures: [] }
  const groups: WorkflowModelGroup[] = (raw.groups ?? []).map(group => ({
    provider: group.id,
    providerName: group.name,
    models: group.models.map(model => ({
      key: modelKeyOf({ provider: group.id, model: model.id }),
      provider: group.id,
      providerName: group.name,
      model: model.id,
      modelName: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      reasoningEfforts: [...(model.reasoning?.efforts ?? [])],
      ...(model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }),
    })),
  }))
  return {
    ...(raw.default === undefined ? {} : { default: raw.default }),
    groups,
    failures: (raw.failures ?? []).map(failure => ({ provider: failure.id, message: failure.message })),
  }
}

/** Find one option by its key. */
export function findModelOption(
  catalog: WorkflowModelCatalogView,
  key: string,
): WorkflowModelOption | undefined {
  for (const group of catalog.groups) {
    const found = group.models.find(model => model.key === key)
    if (found !== undefined) return found
  }
  return undefined
}

/** Find the option matching a remembered/default selection, when the catalog still serves it. */
export function findSelection(
  catalog: WorkflowModelCatalogView,
  selection: WorkflowModelSelection | undefined,
): WorkflowModelOption | undefined {
  if (selection === undefined) return undefined
  return findModelOption(catalog, modelKeyOf(selection))
}

/**
 * Whether a route is one of the known-bad providers that made the old default fail.
 *
 * `tokensfree_ds` was the concrete 502 in the report: its models are listed, but a
 * subscription whose first turn runs there fails. The check is intentionally narrow
 * (provider/model id contains "tokensfree") rather than a general health probe; a
 * catalog that stops listing the route is already handled by `findSelection`.
 */
export function isObviousBadProvider(selection: WorkflowModelSelection): boolean {
  return /tokensfree/i.test(selection.provider + ' ' + selection.model)
}

/** First model in catalog order that is not a known-bad route. */
function firstUsableOption(catalog: WorkflowModelCatalogView): WorkflowModelOption | undefined {
  for (const group of catalog.groups) {
    for (const model of group.models) {
      if (!isObviousBadProvider(model)) return model
    }
  }
  return undefined
}

/**
 * Initial selection for a dialog open.
 *
 * Priority is **workspace default → remembered choice → first usable model**. The
 * workspace default must win over a browser memory: the reported bug was a remembered
 * `tokensfree_ds` selection silently overriding a healthy `dashscope` default and
 * reproducing the 502. A remembered route is only considered while it still exists in
 * the catalog and is not a known-bad provider; a bad workspace default is skipped for
 * a usable remembered route, and only used when there is nothing better.
 *
 * Returns undefined when the catalog is empty, which the dialog renders as
 * "workspace default".
 */
export function initialModelOption(
  catalog: WorkflowModelCatalogView,
  remembered: WorkflowModelSelection | undefined,
): WorkflowModelOption | undefined {
  const defaultOption = findSelection(catalog, catalog.default)
  const rememberedOption = findSelection(catalog, remembered)
  if (defaultOption !== undefined && !isObviousBadProvider(defaultOption)) return defaultOption
  if (rememberedOption !== undefined && !isObviousBadProvider(rememberedOption)) return rememberedOption
  if (defaultOption !== undefined) return defaultOption
  return firstUsableOption(catalog) ?? catalog.groups[0]?.models[0]
}

const isSelection = (value: unknown): value is WorkflowModelSelection => {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.provider === 'string' && record.provider !== ''
    && typeof record.model === 'string' && record.model !== ''
    && (record.reasoningEffort === undefined || typeof record.reasoningEffort === 'string')
}

/** Read the last choice this browser made. Never throws (storage can be disabled). */
export function readRememberedModel(storage?: Pick<Storage, 'getItem'>): WorkflowModelSelection | undefined {
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    if (target === undefined) return undefined
    const raw = target.getItem(WORKFLOW_MODEL_STORAGE_KEY)
    if (raw === null || raw === '') return undefined
    const parsed: unknown = JSON.parse(raw)
    return isSelection(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Remember one choice for the next dialog open. Never throws. */
export function rememberModel(
  selection: WorkflowModelSelection,
  storage?: Pick<Storage, 'setItem'>,
): void {
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    target?.setItem(WORKFLOW_MODEL_STORAGE_KEY, JSON.stringify(selection))
  } catch {
    // A browser with storage disabled still subscribes; only the memory is lost.
  }
}
