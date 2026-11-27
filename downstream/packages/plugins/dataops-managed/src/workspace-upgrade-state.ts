/**
 * Persistent hand-off record for one workspace image upgrade.
 *
 * The DSH companion and the workspace container share the same named volume at
 * `/workspace`; a JSON file there survives the container recreate that applies a new
 * image. The record is deliberately small: only sessions that were running when the
 * user confirmed the upgrade, so recovery cannot send "继续" to unrelated history.
 *
 * @module workspace-upgrade-state
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Format version of the persisted hand-off record. */
export const WORKSPACE_UPGRADE_STATE_VERSION = 1

/** One DSH session that was running when the upgrade was confirmed. */
export interface WorkspaceUpgradeSession {
  /** DSH session id, the id `agents.get` and `agents.resume` accept. */
  sessionId: string
  /** Optional human-readable title captured for diagnostics. */
  title?: string
  /** Optional workspace directory captured for diagnostics. */
  cwd?: string
}

/** The JSON document written before the container is recreated. */
export interface WorkspaceUpgradeState {
  version: typeof WORKSPACE_UPGRADE_STATE_VERSION
  upgradeId: string
  targetImage: string
  sessions: WorkspaceUpgradeSession[]
  createdAt: string
}

/** Directory used by this plugin below the DSH home. */
export const WORKSPACE_UPGRADE_STATE_DIR = 'dataops-managed'

/** Name of the hand-off file. */
export const WORKSPACE_UPGRADE_STATE_FILE = 'workspace-upgrade.json'

/**
 * Resolve the persistent DSH home used by this workspace.
 *
 * The companion currently starts with `DSH_HOME=/workspace/.dataops/dsh`; the fallback
 * keeps tests and a manually launched host deterministic without reaching outside the
 * mounted workspace.
 * @param dshHome - override for tests.
 * @returns the state directory path.
 */
export function workspaceUpgradeStatePath(dshHome = process.env.DSH_HOME ?? '/workspace/.dataops/dsh'): string {
  return join(dshHome, WORKSPACE_UPGRADE_STATE_DIR, WORKSPACE_UPGRADE_STATE_FILE)
}

/** Validate one persisted session entry. */
function asSession(value: unknown): WorkspaceUpgradeSession | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.sessionId !== 'string' || record.sessionId.trim() === '') return null
  return {
    sessionId: record.sessionId.trim(),
    ...(typeof record.title === 'string' && record.title.trim() !== '' ? { title: record.title.trim() } : {}),
    ...(typeof record.cwd === 'string' && record.cwd.trim() !== '' ? { cwd: record.cwd.trim() } : {}),
  }
}

/** Validate a parsed state document. */
export function asWorkspaceUpgradeState(value: unknown): WorkspaceUpgradeState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.version !== WORKSPACE_UPGRADE_STATE_VERSION) return null
  if (typeof record.upgradeId !== 'string' || record.upgradeId.trim() === '') return null
  if (typeof record.targetImage !== 'string' || record.targetImage.trim() === '') return null
  if (!Array.isArray(record.sessions)) return null
  const sessions = record.sessions.map(asSession).filter((session): session is WorkspaceUpgradeSession => session !== null)
  return {
    version: WORKSPACE_UPGRADE_STATE_VERSION,
    upgradeId: record.upgradeId.trim(),
    targetImage: record.targetImage.trim(),
    sessions,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
  }
}

/**
 * Read the pending hand-off record.
 * @param file - state file path.
 * @returns the record, or null when none exists or it cannot be parsed.
 */
export async function readWorkspaceUpgradeState(
  file = workspaceUpgradeStatePath(),
): Promise<WorkspaceUpgradeState | null> {
  try {
    return asWorkspaceUpgradeState(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return null
  }
}

/**
 * Persist the hand-off record atomically.
 *
 * A partially written JSON file would be indistinguishable from "no upgrade pending",
 * which would silently skip recovery. The temporary file is renamed into place only
 * after the content is complete.
 * @param state - record to persist.
 * @param file - state file path.
 */
export async function writeWorkspaceUpgradeState(
  state: WorkspaceUpgradeState,
  file = workspaceUpgradeStatePath(),
): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8')
  await rename(temporary, file)
}

/**
 * Remove the hand-off record after recovery has been attempted.
 * @param file - state file path.
 */
export async function clearWorkspaceUpgradeState(file = workspaceUpgradeStatePath()): Promise<void> {
  await rm(file, { force: true })
}
