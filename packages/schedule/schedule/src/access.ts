/**
 * Deployment access policy for Schedule management tools.
 *
 * The Schedule package owns one Session's reminders. Deployment identity
 * (user, department, role) is configuration owned by the composed profile;
 * this module only applies that policy to tool calls and resolves the owner
 * label attached to one Session.
 * @module @deepseek-ai/dsh-schedule/access
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ScheduleAccessConfig,
  ScheduleOwner,
  ScheduleManagementError,
  ScheduleRole,
} from './types.ts'

/** Role used when a deployment supplies no explicit Schedule access policy. */
export const DEFAULT_SCHEDULE_ROLE: ScheduleRole = 'user'

/** Whether a role may enumerate other Sessions' reminders. */
export function canListAll(role: ScheduleRole): boolean {
  return role === 'super_admin' || role === 'admin' || role === 'dept_admin'
}

/** Resolve the caller role from configuration. */
export function callerRole(config: ScheduleAccessConfig | undefined): ScheduleRole {
  return config?.role ?? DEFAULT_SCHEDULE_ROLE
}

/** Resolve one Session's owner label, preferring an explicit override. */
export function ownerForSession(
  config: ScheduleAccessConfig | undefined,
  sessionId: SessionId,
): ScheduleOwner {
  const override = config?.sessionOwners?.find(entry => entry.sessionId === sessionId)
  if (override !== undefined) {
    return {
      userId: override.userId,
      ...override.userName === undefined ? {} : { userName: override.userName },
      ...override.departmentCode === undefined ? {} : { departmentCode: override.departmentCode },
      ...override.departmentName === undefined ? {} : { departmentName: override.departmentName },
    }
  }
  if (config?.owner !== undefined) return config.owner
  return { userId: sessionId }
}

/** Stable denial for one out-of-scope list request. */
export function forbidden(message: string): ScheduleManagementError {
  return { code: 'forbidden', message }
}

/** Resolve and validate the server-owned filters for `schedule_list_all`. */
export function listAllScope(
  role: ScheduleRole,
  ownDepartment: string | undefined,
  department: string | undefined,
  user: string | undefined,
): { readonly department?: string; readonly user?: string } | ScheduleManagementError {
  if (!canListAll(role)) {
    return forbidden('schedule_list_all requires an administrator role.')
  }
  if (role === 'dept_admin') {
    if (ownDepartment === undefined) {
      return forbidden('A department administrator needs a configured department.')
    }
    if (department !== undefined && department !== ownDepartment) {
      return forbidden('A department administrator may only list their own department.')
    }
    return { department: ownDepartment, ...user === undefined ? {} : { user } }
  }
  return {
    ...department === undefined ? {} : { department },
    ...user === undefined ? {} : { user },
  }
}

/** Approval outcomes the Schedule write gate distinguishes. */
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** The slice of the approval service Schedule needs, declared locally to avoid a hard dependency. */
interface ApprovalService {
  request(request: {
    agent: Agent
    toolName: string
    callId?: string
    reason?: string
    signal?: AbortSignal
  }): Promise<ApprovalOutcome>
}

/** Resolve the optional approval service from the global context. */
function approvalService(ctx: Context): ApprovalService | undefined {
  return (ctx as unknown as { get(name: string): unknown }).get('approval') as ApprovalService | undefined
}

/** Require one human approval for a Schedule write. */
export async function requestWriteApproval(
  ctx: Context,
  agent: Agent,
  toolName: string,
  callId: string,
  reason: string,
  signal: AbortSignal,
): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly error: ScheduleManagementError }> {
  const approval = approvalService(ctx)
  if (approval === undefined) {
    return {
      allowed: false,
      error: {
        code: 'approval_unavailable',
        message: 'Schedule management writes require an approval service; none is composed.',
      },
    }
  }
  let outcome: ApprovalOutcome
  try {
    outcome = await approval.request({ agent, toolName, callId, reason, signal })
  } catch {
    return {
      allowed: false,
      error: {
        code: 'approval_unavailable',
        message: 'The approval service could not answer the Schedule write request.',
      },
    }
  }
  if (outcome === 'allowed-once') return { allowed: true }
  if (outcome === 'rejected') {
    return {
      allowed: false,
      error: { code: 'approval_rejected', message: 'The Schedule write was rejected by the approver.' },
    }
  }
  return {
    allowed: false,
    error: {
      code: 'approval_unavailable',
      message: outcome === 'cancelled'
        ? 'The Schedule write approval was cancelled.'
        : 'No approval answerer accepted the Schedule write request.',
    },
  }
}
