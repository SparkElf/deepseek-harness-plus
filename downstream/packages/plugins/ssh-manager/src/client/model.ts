import type { SshCredentialInput, SshHost } from '../types.ts'
export interface PathCrumb { label: string; path: string }

export function pathBreadcrumbs(path: string): PathCrumb[] {
  const normalized = path.trim().replace(/\/+$/u, '') || (path.startsWith('/') ? '/' : '.')
  if (normalized === '.') return [{ label: 'Home', path: '.' }]
  if (normalized === '/') return [{ label: 'Root', path: '/' }]
  const absolute = normalized.startsWith('/')
  const parts = normalized.split('/').filter(Boolean)
  const crumbs: PathCrumb[] = [{ label: absolute ? 'Root' : 'Home', path: absolute ? '/' : '.' }]
  let current = absolute ? '' : '.'
  for (const part of parts) {
    current = absolute ? current + '/' + part : current === '.' ? part : current + '/' + part
    crumbs.push({ label: part, path: current })
  }
  return crumbs
}

export function parentPath(path: string): string {
  if (path === '/' || path === '.') return path
  const parts = path.replace(/\/+$/u, '').split('/')
  parts.pop()
  return parts.join('/') || (path.startsWith('/') ? '/' : '.')
}

export function joinedPath(path: string, name: string): string {
  return path === '/' ? '/' + name : path === '.' ? name : path.replace(/\/+$/u, '') + '/' + name
}

export function formatBytes(value: number): string {
  if (value < 1024) return value.toString() + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
  if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB'
  return (value / 1024 / 1024 / 1024).toFixed(1) + ' GB'
}

/** Per-field validation state shared by the wizard and the host form. */
export interface FieldErrors {
  name?: boolean
  hostname?: boolean
  port?: boolean
  username?: boolean
  credential?: boolean
  jumpHost?: boolean
}

/** Validate the identity step: name, address, port, and login user. */
export function identityErrors(host: SshHost): FieldErrors {
  const errors: FieldErrors = {}
  if (host.name.trim() === '') errors.name = true
  if (host.hostname.trim() === '') errors.hostname = true
  if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535) errors.port = true
  if (host.username.trim() === '') errors.username = true
  return errors
}

/**
 * Validate the authentication step.
 *
 * An edited host that already has a stored credential may leave the secret fields
 * empty: empty means "keep the stored credential", which is what the server does.
 */
export function credentialErrors(host: SshHost, credential: SshCredentialInput, configured: boolean): FieldErrors {
  if (configured) return {}
  if (host.authKind === 'password' && (credential.password ?? '') === '') return { credential: true }
  if (host.authKind === 'private-key' && (credential.privateKey ?? '').trim() === '') return { credential: true }
  return {}
}

/** Validate the advanced step against the inventory the host will be saved into. */
export function advancedErrors(host: SshHost, hosts: SshHost[]): FieldErrors {
  if (host.jumpHostId === null || host.jumpHostId === '') return {}
  if (host.jumpHostId === host.id) return { jumpHost: true }
  return hosts.some(candidate => candidate.id === host.jumpHostId) ? {} : { jumpHost: true }
}

/** Whether any inline field error is present. */
export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0
}

/** Whether the draft has enough identity to attempt a connection. */
export function canTestHost(host: SshHost): boolean {
  return !hasErrors(identityErrors(host))
}

/** A stored test outcome for one host, shown as the list/detail status tag. */
export interface HostTestResult {
  ok: boolean
  latencyMs?: number
  error?: string
  fingerprint?: string
  at: number
}

/** Locally remembered per-host usage; the inventory itself stays server-owned. */
export interface HostUsage {
  openedAt?: number
  test?: HostTestResult
}

/** Trim a fingerprint for display; absent stays absent. */
export function fingerprintOf(host: SshHost): string {
  return (host.knownHostFingerprint ?? '').trim()
}

/** Hosts that were opened or tested, most recent first. */
export function recentHosts(hosts: SshHost[], usage: Record<string, HostUsage>, limit = 5): SshHost[] {
  return hosts
    .map(host => ({ host, at: usage[host.id]?.openedAt ?? 0 }))
    .filter(entry => entry.at > 0)
    .sort((left, right) => right.at - left.at || left.host.name.localeCompare(right.host.name))
    .slice(0, limit)
    .map(entry => entry.host)
}

/** Stable display id for a wizard step. */
export type WizardStep = 0 | 1 | 2

/** Steps in order, used by both the stepper and the navigation guards. */
export const WIZARD_STEPS: readonly WizardStep[] = [0, 1, 2]
