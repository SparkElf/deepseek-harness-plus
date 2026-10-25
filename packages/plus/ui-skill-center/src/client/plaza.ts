/**
 * Skill-plaza sharing state shown on a local skill card.
 *
 * Sharing is owned by DataOps: the same-origin `dataops-managed` bridge talks
 * to the backend with the workspace credential, and the backend enforces
 * ownership/review. This module only maps a local skill name to the record the
 * bridge reports, so the card can show 未共享 / 待审核 / 已上架 / 已驳回.
 *
 * @module @sparkelf/dsh-client-ui-skill-center/client/plaza
 */

/** Review/publish state of one local skill in the plaza. */
export type PlazaStatus = 'local' | 'pending' | 'approved' | 'rejected'

/** One plaza record, as `GET /integrations/dataops/skill-plaza?mine=1` reports it. */
export interface PlazaSkill {
  id: number
  name: string
  reviewStatus?: 'pending' | 'approved' | 'rejected'
  visibility?: 'global' | 'department' | 'private'
  departmentCode?: string
  departmentName?: string
  sharedByMe?: boolean
  reviewNote?: string
  updatedAt?: string
}

/** The share state one local card should render. */
export interface PlazaShare {
  status: PlazaStatus
  /** The plaza row, when one exists (needed for unshare and the review note). */
  record?: PlazaSkill
  /** True when the record is shared by this workspace (shows 取消共享). */
  sharedByMe: boolean
}

/** Map one local skill name to its share state. */
export function shareOf(name: string, records: ReadonlyMap<string, PlazaSkill>): PlazaShare {
  const record = records.get(name)
  if (record === undefined) return { status: 'local', sharedByMe: false }
  // An older bridge row has no reviewStatus; a row that is sharedByMe is an
  // already-approved plaza entry there, so it maps to approved rather than
  // pretending the new backend's pending state.
  const status: PlazaStatus = record.reviewStatus
    ?? (record.sharedByMe === true ? 'approved' : 'local')
  return { status, record, sharedByMe: record.sharedByMe === true }
}

/** Whether a share state offers the 上架 / 重新提交 action. */
export function canSubmit(status: PlazaStatus): boolean {
  return status === 'local' || status === 'rejected'
}
