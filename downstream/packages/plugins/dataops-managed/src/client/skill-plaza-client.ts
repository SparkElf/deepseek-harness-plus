/** Same-origin skill plaza calls from the DataOps skill center section. */

import type { ReviewStatus, ResourceVisibility } from './review-types.ts'
import { normalizeReviewStatus, normalizeVisibility } from './review-types.ts'

/** Route the plugin's Host half serves for the plaza. */
export const SKILL_PLAZA_PATH = 'integrations/dataops/skill-plaza'

/** One plaza entry as the section reads it. */
export interface PlazaSkill {
  id: number
  name: string
  description?: string
  instruction: string
  tags: string[]
  sharedByMe: boolean
  updatedAt: string
  reviewStatus: ReviewStatus
  visibility: ResourceVisibility
  departmentCode?: string | null
  departmentName?: string
  departmentPath?: readonly { code: string; name: string }[]
  ownerName?: string
  riskReport?: import('./review-types.ts').RiskReport | null
  reviewNote?: string | null
  submittedAt?: string
}

/** The plaza listing and the tags in use. */
export interface PlazaListing {
  skills: PlazaSkill[]
  tags: string[]
  counts?: { pending: number; approved: number; rejected: number; total: number }
}

/** Narrow an unknown value to a plaza entry. */
function asSkill(value: unknown): PlazaSkill | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'number' || typeof row.name !== 'string') return null
  return {
    id: row.id,
    name: row.name,
    description: typeof row.description === 'string' ? row.description : undefined,
    instruction: typeof row.instruction === 'string' ? row.instruction : '',
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    sharedByMe: row.sharedByMe === true,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
    reviewStatus: normalizeReviewStatus(row.reviewStatus),
    visibility: normalizeVisibility(row.visibility),
    departmentCode: typeof row.departmentCode === 'string' ? row.departmentCode : null,
    departmentName: typeof row.departmentName === 'string' ? row.departmentName : undefined,
    departmentPath: Array.isArray(row.departmentPath)
      ? row.departmentPath.flatMap(entry => (
        typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string'
          ? [{ code: String((entry as { code?: unknown }).code ?? ''), name: String((entry as { name: string }).name) }]
          : []
      ))
      : undefined,
    ownerName: typeof row.ownerName === 'string' ? row.ownerName : undefined,
    riskReport: typeof row.riskReport === 'object' && row.riskReport !== null ? row.riskReport as PlazaSkill['riskReport'] : null,
    reviewNote: typeof row.reviewNote === 'string' ? row.reviewNote : null,
    submittedAt: typeof row.submittedAt === 'string' ? row.submittedAt : undefined,
  }
}

/** Narrow an unknown value to the listing. */
function asListing(value: unknown): PlazaListing | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const source = Array.isArray(row.skills) ? row.skills : Array.isArray(row.items) ? row.items : []
  const skills = source.flatMap((entry) => asSkill(entry) ?? [])
  const tags = Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : []
  const rawCounts = typeof row.counts === 'object' && row.counts !== null ? row.counts as Record<string, unknown> : {}
  const counts = Object.keys(rawCounts).length === 0 ? undefined : {
    pending: Number(rawCounts.pending ?? 0),
    approved: Number(rawCounts.approved ?? 0),
    rejected: Number(rawCounts.rejected ?? 0),
    total: Number(rawCounts.total ?? skills.length),
  }
  return { skills, tags, counts }
}

/**
 * Read the plaza.
 * @param filter - Optional tag and text filters.
 * @returns The listing, or null when this workspace is not connected to DataOps.
 */
export async function fetchPlaza(filter: { tag?: string; query?: string; status?: string; scope?: string } = {}): Promise<PlazaListing | null> {
  const params = new URLSearchParams()
  if (filter.tag !== undefined && filter.tag !== '') params.set('tag', filter.tag)
  if (filter.query !== undefined && filter.query !== '') params.set('q', filter.query)
  if (filter.status !== undefined) params.set('status', filter.status)
  if (filter.scope !== undefined) params.set('scope', filter.scope)
  const suffix = params.size === 0 ? '' : '?' + params.toString()
  const response = await fetch(SKILL_PLAZA_PATH + suffix, { headers: { accept: 'application/json' } })
  if (response.status === 503) return null
  if (!response.ok) throw new Error('skill plaza read failed with HTTP ' + String(response.status))
  return asListing(await response.json())
}

/**
 * Change the plaza.
 * @param body - Action and its parameters.
 * @returns The parsed reply, or null when the plugin is not active.
 */
export async function postPlazaAction(body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(SKILL_PLAZA_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.status === 503) return null
  if (!response.ok) throw new Error('skill plaza action failed with HTTP ' + String(response.status))
  return await response.json()
}
