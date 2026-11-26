/**
 * Cron handling for the workflow plaza: shortcut mapping and shape checking ONLY.
 *
 * This module deliberately does NOT parse or interpret cron. The DSH Schedule owns the
 * expression's meaning, and a second implementation here would be a second opinion
 * about when a task runs -- exactly the "two answers for one fact" defect this codebase
 * keeps removing. What the dialog needs is narrower:
 *
 * - map a frequency shortcut to the expression it stands for, and
 * - tell the reader whether what they typed has the right SHAPE, so a typo is caught
 *   while they are still looking at the field instead of failing a minute later.
 *
 * Anything beyond that is handed to the Schedule verbatim.
 *
 * @module @sparkelf/dsh-knowledge-base/client/workflows/cron
 */

/** Number of space-separated fields a standard five-field cron expression has. */
export const CRON_FIELD_COUNT = 5

/** Why a custom expression was rejected, or that it is usable. */
export type CronCheck =
  | { readonly ok: true; readonly cron: string }
  | { readonly ok: false; readonly reason: CronRejection }

/** Why an expression cannot be submitted. */
export type CronRejection =
  | 'empty'
  | 'fieldCount'
  /** An interval count that is not a whole number. */
  | 'notInteger'
  /** An interval count outside the range the shortcut allows. */
  | 'outOfRange'

/**
 * Check the SHAPE of a custom cron expression.
 *
 * Only the field count is checked: it is the mistake a reader actually makes (typing
 * four fields, or pasting a six-field expression with seconds), and it is the one that
 * the Schedule rejects outright. Ranges, steps and names are left alone -- judging those
 * would mean interpreting the expression, which is the Schedule's job.
 *
 * Whitespace is normalised to single spaces so the value stored matches what the reader
 * would see in the task detail.
 *
 * @param raw - exactly what the reader typed.
 * @returns the normalised expression, or the reason it cannot be submitted.
 */
export function checkCustomCron(raw: string): CronCheck {
  const cron = raw.trim().split(/\s+/).filter(field => field !== '').join(' ')
  if (cron === '') return { ok: false, reason: 'empty' }
  if (cron.split(' ').length !== CRON_FIELD_COUNT) return { ok: false, reason: 'fieldCount' }
  return { ok: true, cron }
}

/**
 * The expression a frequency shortcut stands for.
 *
 * @param frequencyId - shortcut chosen in the dialog.
 * @param workflow - whose frequencies are offered.
 * @param customRaw - the custom field's text, used only for `custom`.
 * @param intervalRaw - the count field's text, used only for the interval shortcuts.
 * @returns the expression to submit, or undefined when a custom value is not usable yet.
 */
export function resolveCron(
  frequencyId: string,
  workflow: { readonly frequencies: readonly { readonly id: string; readonly cron?: string }[] },
  customRaw: string,
  intervalRaw = '',
): CronCheck {
  if (frequencyId === 'custom') return checkCustomCron(customRaw)
  if (isIntervalFrequency(frequencyId)) return intervalCron(INTERVAL_SPECS[frequencyId], intervalRaw)
  const match = workflow.frequencies.find(frequency => frequency.id === frequencyId)
  if (match?.cron === undefined) return { ok: false, reason: 'empty' }
  return { ok: true, cron: match.cron }
}

/** Which counter an interval shortcut edits. */
export type IntervalUnit = 'hours' | 'minutes'

/** The id of the two interval shortcuts, as stored in a workflow definition. */
export type IntervalFrequencyId = 'everyHours' | 'everyMinutes'

/** One interval shortcut: its bounds and the count it starts from. */
export interface IntervalSpec {
  readonly id: IntervalFrequencyId
  readonly unit: IntervalUnit
  /** Smallest accepted count, inclusive. */
  readonly min: number
  /** Largest accepted count, inclusive. */
  readonly max: number
  /** Count the dialog starts on; never blank, so the field is always usable. */
  readonly defaultCount: number
}

/**
 * The interval shortcuts every built-in workflow offers.
 *
 * Hourly stops at 23 and minutely at 59 because a larger count is not a shorter
 * interval -- it is a different rule, and a 90-minute step would silently mean something
 * the reader did not ask for. Rejecting keeps the generated expression honest.
 *
 * (Cron examples are kept out of these comments on purpose: the two-character sequence
 * that begins a step value also ends a block comment.)
 */
export const INTERVAL_SPECS: Readonly<Record<IntervalFrequencyId, IntervalSpec>> = {
  everyHours: { id: 'everyHours', unit: 'hours', min: 1, max: 23, defaultCount: 6 },
  everyMinutes: { id: 'everyMinutes', unit: 'minutes', min: 1, max: 59, defaultCount: 30 },
}

/** Whether a frequency id selects an interval shortcut. */
export function isIntervalFrequency(id: string): id is IntervalFrequencyId {
  return id === 'everyHours' || id === 'everyMinutes'
}

/**
 * Build the expression an interval stands for.
 *
 * Hourly pins the minute field to 0, so the task runs on the hour rather than sixty
 * times at an arbitrary offset. Minutely has no such anchor and steps the minute field
 * directly.
 *
 * The count is validated rather than clamped: a reader who types 25 hours gets told the
 * range instead of quietly being given 23, because a silently altered schedule is a
 * schedule they did not choose.
 *
 * @param spec - which shortcut, and the bounds it accepts.
 * @param raw - the count exactly as it appears in the field.
 * @returns the expression, or why the count cannot be used.
 */
export function intervalCron(spec: IntervalSpec, raw: string): CronCheck {
  const text = raw.trim()
  if (text === '') return { ok: false, reason: 'empty' }
  // `Number('1.5')` is finite and in range, so integrality is checked explicitly rather
  // than relying on the bounds alone.
  if (!/^\d+$/.test(text)) return { ok: false, reason: 'notInteger' }
  const count = Number(text)
  if (count < spec.min || count > spec.max) return { ok: false, reason: 'outOfRange' }
  return {
    ok: true,
    cron: spec.unit === 'hours' ? `0 */${String(count)} * * *` : `*/${String(count)} * * * *`,
  }
}

/** A frequency shortcut as the dialog renders it: id, cron, and a locale key for its label. */
export interface FrequencyChoice {
  readonly id: string
  readonly cron: string | undefined
  readonly labelKey: string
}

/**
 * Build the dialog's frequency radio list for one workflow.
 *
 * @param workflow - whose frequencies to present.
 * @param defaultCron - the workflow's prefilled expression, used for `custom`'s field.
 * @returns one entry per shortcut, in the workflow's declared order.
 */
export function frequencyChoices(
  workflow: { readonly frequencies: readonly { readonly id: string; readonly cron?: string }[] },
  defaultCron: string,
): FrequencyChoice[] {
  return workflow.frequencies.map(frequency => ({
    id: frequency.id,
    cron: frequency.cron ?? defaultCron,
    labelKey: `workflow.frequency.${frequency.id}`,
  }))
}
