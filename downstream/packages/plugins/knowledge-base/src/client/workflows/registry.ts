/**
 * The built-in workflow registry behind the 「工作流广场」 tab.
 *
 * A workflow is a TEMPLATE, not a scheduler. Every field here is static data: the
 * plaza renders these cards, and subscribing turns one of them into an ordinary DSH
 * Schedule using the existing `schedule_create` tool. Nothing in this module runs
 * anything, parses a cron expression, or talks to a server -- keeping the definitions
 * inert is what makes the plaza cheap to extend and impossible to break by adding a
 * card.
 *
 * ## Why the definitions live in this plugin
 *
 * DataOps owns sharing: which buckets a person can see. It does not schedule work and
 * does not execute it, so it has no say in what a workflow is. A workflow that needs
 * to read or write knowledge documents still goes through the knowledge API at run
 * time, which is where DataOps' permissions already apply.
 *
 * @module @sparkelf/dsh-knowledge-base/client/workflows/registry
 */

/** Which icon a plaza card shows. Mapped to a concrete glyph by the component. */
export type WorkflowIcon = 'organize' | 'index' | 'archive'

/** One frequency shortcut offered in the subscribe dialog. */
export interface WorkflowFrequency {
  /**
   * Stable id, also used as the radio button's DOM hook.
   *
   * `everyHours` / `everyMinutes` are interval shortcuts: their expression depends on a
   * count the reader edits, so they carry no `cron` here and are resolved by `cron.ts`
   * from `INTERVAL_SPECS` instead.
   */
  readonly id: 'daily' | 'weekly' | 'monthly' | 'everyHours' | 'everyMinutes' | 'custom'
  /** The cron expression this shortcut fills in, or `undefined` for `custom`. */
  readonly cron?: string
}

/** One built-in workflow, as the plaza renders and subscribes it. */
export interface WorkflowDefinition {
  /**
   * Stable identity, and the ONLY thing deduplication is allowed to key on.
   *
   * Titles are copy and will be edited; ids are the contract. A subscribed task is
   * recognised by this string appearing in its prompt, so changing an id orphans
   * existing subscriptions -- treat the value as frozen once shipped.
   */
  readonly id: string
  /** Locale key for the card title. */
  readonly titleKey: string
  /** Locale key for the card description. */
  readonly descriptionKey: string
  /** Card glyph. */
  readonly icon: WorkflowIcon
  /** Published records carry their own copy; built-ins resolve it from locale keys. */
  readonly title?: string
  readonly description?: string
  /** Category/author shown on a published card; absent for built-ins. */
  readonly category?: string
  readonly authorName?: string
  /** Cron prefilled in the subscribe dialog before the reader touches anything. */
  readonly defaultCron: string
  /** Frequency shortcuts, in the order the dialog shows them. */
  readonly frequencies: readonly WorkflowFrequency[]
  /**
   * What the scheduled session should actually do.
   *
   * This is the body of the prompt handed to a new session, and it becomes the
   * Schedule's own prompt, so it must read as a standing instruction rather than as
   * a one-off request: it runs again every time the schedule fires.
   */
  readonly instruction: string
}

/**
 * The marker a subscribed task carries, so its workflow can be recognised later.
 *
 * Deliberately plain text inside the prompt: DSH Schedules have no user-data field,
 * and the prompt is the one part of a Schedule this plugin controls. A marker that is
 * visible in the prompt is also honest -- opening the task detail shows which workflow
 * produced it.
 *
 * @param id - workflow id to mark.
 * @returns the marker string, e.g. `[workflow:kb-organize-personal]`.
 */
export function workflowMarker(id: string): string {
  return `[workflow:${id}]`
}

/** Daily at 09:00. */
const DAILY_NINE = '0 9 * * *'
/** Monday at 09:00. */
const WEEKLY_MONDAY_NINE = '0 9 * * 1'
/** First day of the month at 09:00. */
const MONTHLY_FIRST_NINE = '0 9 1 * *'

/** Frequency shortcuts every built-in workflow offers. */
export const STANDARD_FREQUENCIES: readonly WorkflowFrequency[] = [
  { id: 'daily', cron: DAILY_NINE },
  { id: 'weekly', cron: WEEKLY_MONDAY_NINE },
  { id: 'monthly', cron: MONTHLY_FIRST_NINE },
  // Intervals sit between the calendar shortcuts and `custom`: they are still presets,
  // but the reader adjusts the count, which is what makes them a distinct kind.
  { id: 'everyHours' },
  { id: 'everyMinutes' },
  { id: 'custom' },
]

/**
 * The built-in workflows, in the order the plaza shows them.
 *
 * Each one names a capability the knowledge plugin already has, so subscribing cannot
 * promise something the deployment cannot do. Adding a card means adding a definition
 * here and its copy keys; no other wiring is required.
 */
export const BUILT_IN_WORKFLOWS: readonly WorkflowDefinition[] = [
  {
    id: 'kb-organize-personal',
    titleKey: 'workflow.organize.title',
    descriptionKey: 'workflow.organize.description',
    icon: 'organize',
    defaultCron: WEEKLY_MONDAY_NINE,
    frequencies: STANDARD_FREQUENCIES,
    instruction: [
      '整理我的个人知识库。',
      '使用知识库整理能力（kb-organize）：先读取 personal 桶下的文档，按主题建立分层文件夹，',
      '把文档归入对应主题，然后为每一层写一份索引 Markdown。',
      '目标范围仅限 personal/<我的用户 id>，不要读取或修改 global 与 department 桶。',
      '整理完成后简要报告：移动了哪些文件、新建了哪些索引。',
    ].join('\n'),
  },
  {
    id: 'kb-index-personal',
    titleKey: 'workflow.index.title',
    descriptionKey: 'workflow.index.description',
    icon: 'index',
    defaultCron: DAILY_NINE,
    frequencies: STANDARD_FREQUENCIES,
    instruction: [
      '重建我的个人知识库索引。',
      '扫描 personal/<我的用户 id> 下的全部文档，补齐缺失的 Markdown 文本副本，',
      '然后生成或更新该层级的索引 Markdown，使其与当前文件列表一致。',
      '不要移动或删除任何原始文档，只补索引与文本副本。',
    ].join('\n'),
  },
  {
    id: 'kb-archive-stale',
    titleKey: 'workflow.archive.title',
    descriptionKey: 'workflow.archive.description',
    icon: 'archive',
    defaultCron: MONTHLY_FIRST_NINE,
    frequencies: STANDARD_FREQUENCIES,
    instruction: [
      '归档我的个人知识库中过期的文档。',
      '检查 personal/<我的用户 id> 下最近一次修改早于 90 天的文档，',
      '把它们移动到该桶下的「归档」文件夹（不存在则创建），并在索引中标注为已归档。',
      '不要删除任何文档；无法判断的保持原位并在报告中列出。',
    ].join('\n'),
  },
]

/**
 * Find one built-in workflow by id.
 *
 * @param id - workflow id to look up.
 * @returns the definition, or undefined when no such workflow is built in.
 */
export function findWorkflow(id: string): WorkflowDefinition | undefined {
  return BUILT_IN_WORKFLOWS.find(workflow => workflow.id === id)
}
