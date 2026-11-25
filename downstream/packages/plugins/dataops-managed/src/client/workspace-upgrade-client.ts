/** Same-origin calls for the workspace image upgrade banner. */

/** Route the plugin's Host half serves for upgrade detection and start. */
export const WORKSPACE_UPGRADE_PATH = 'integrations/dataops/workspace-upgrade'

/** A DSH session that will receive "继续" after the restart. */
export interface WorkspaceUpgradeSession {
  sessionId: string
  title?: string
  cwd?: string
}

/** The status the DSH page reads before offering an upgrade. */
export interface WorkspaceUpgradeStatus {
  imageStatus: 'CURRENT' | 'UPDATE_AVAILABLE' | 'NOT_RUNNING' | 'UNKNOWN'
  configuredImage: string
  activeSessions: WorkspaceUpgradeSession[]
}

/** Narrow an unknown response into the status contract. */
function asStatus(value: unknown): WorkspaceUpgradeStatus | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const imageStatus = record.imageStatus
  if (imageStatus !== 'CURRENT' && imageStatus !== 'UPDATE_AVAILABLE' && imageStatus !== 'NOT_RUNNING' && imageStatus !== 'UNKNOWN') return null
  const sessions = Array.isArray(record.activeSessions)
    ? record.activeSessions.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
      const session = entry as Record<string, unknown>
      if (typeof session.sessionId !== 'string' || session.sessionId.trim() === '') return []
      return [{
        sessionId: session.sessionId.trim(),
        ...(typeof session.title === 'string' && session.title.trim() !== '' ? { title: session.title.trim() } : {}),
        ...(typeof session.cwd === 'string' && session.cwd.trim() !== '' ? { cwd: session.cwd.trim() } : {}),
      }]
    })
    : []
  return {
    imageStatus,
    configuredImage: typeof record.configuredImage === 'string' ? record.configuredImage : '',
    activeSessions: sessions,
  }
}

/**
 * Read the workspace upgrade preview.
 * @returns the status, or null when the Host route is not ready or not connected.
 */
export async function fetchWorkspaceUpgrade(): Promise<WorkspaceUpgradeStatus | null> {
  const response = await fetch(WORKSPACE_UPGRADE_PATH, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (response.status === 503 || response.status === 401) return null
  if (!response.ok) throw new Error(`workspace upgrade preview failed with HTTP ${String(response.status)}`)
  return asStatus(await response.json())
}

/**
 * Ask the Host to snapshot sessions and recreate the workspace container.
 * @returns the accepted hand-off summary.
 */
export async function requestWorkspaceUpgrade(): Promise<{ accepted: boolean; upgradeId: string; sessions: number }> {
  const response = await fetch(WORKSPACE_UPGRADE_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ force: true }),
  })
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) {
    const message = typeof body?.error === 'string' ? body.error : `workspace upgrade failed with HTTP ${String(response.status)}`
    throw new Error(message)
  }
  return {
    accepted: body?.accepted === true,
    upgradeId: typeof body?.upgradeId === 'string' ? body.upgradeId : '',
    sessions: typeof body?.sessions === 'number' ? body.sessions : 0,
  }
}
