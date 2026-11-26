/**
 * Approved workflows from the profile-local publish store, as plaza cards.
 *
 * The server decides what is public; this module only turns an approved record into the
 * same inert definition the built-ins use. Keeping it pure makes the merge testable
 * without a browser, and keeps the plaza from knowing where the store lives.
 *
 * @module @sparkelf/dsh-knowledge-base/client/workflows/published
 */

import { checkCustomCron } from './cron.ts'
import {
  STANDARD_FREQUENCIES,
  type WorkflowDefinition,
} from './registry.ts'

/** One approved workflow as the HTTP route reports it. */
export interface PublishedWorkflowView {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly instruction: string
  readonly cronHint: string
  readonly category: string
  readonly authorId?: string
  readonly authorName?: string
  readonly createdAt?: string
  readonly status?: 'pending' | 'approved' | 'rejected' | 'unpublished'
  readonly reviewStatus?: 'pending' | 'approved' | 'rejected'
  readonly reviewedByName?: string
  readonly reviewNote?: string
  readonly visibility?: 'global' | 'department' | 'private'
  readonly departmentCode?: string | null
  readonly departmentName?: string | null
  readonly updatedAt?: string
  readonly reviewedAt?: string
  readonly unpublishedAt?: string | null
  readonly submittedAt?: string
  readonly ownerId?: string
}

/** Fallback cron when an author supplied only prose or no hint. */
const FALLBACK_CRON = '0 9 * * 1'

/**
 * Turn one approved record into a plaza definition.
 *
 * The record id is the identity: the subscription marker embeds it, so a re-reviewed
 * record keeps its dedupe identity while its copy can change.
 */
export function publishedDefinition(record: PublishedWorkflowView): WorkflowDefinition {
  const cron = checkCustomCron(record.cronHint)
  return {
    id: record.id,
    titleKey: '',
    descriptionKey: '',
    title: record.title,
    description: record.description,
    category: record.category === '' ? undefined : record.category,
    ...(record.authorName === undefined || record.authorName === '' ? {} : { authorName: record.authorName }),
    icon: 'organize',
    defaultCron: cron.ok ? cron.cron : FALLBACK_CRON,
    frequencies: STANDARD_FREQUENCIES,
    instruction: record.instruction,
  }
}

/** Merge built-ins with approved records, keeping built-ins first and ids unique. */
export function mergePublishedWorkflows(
  builtIns: readonly WorkflowDefinition[],
  approved: readonly PublishedWorkflowView[],
): WorkflowDefinition[] {
  const seen = new Set(builtIns.map(workflow => workflow.id))
  const merged = [...builtIns]
  for (const record of approved) {
    if (seen.has(record.id)) continue
    seen.add(record.id)
    merged.push(publishedDefinition(record))
  }
  return merged
}
