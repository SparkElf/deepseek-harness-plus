import type { SshManagerState } from '../types.ts'

export async function sshApi<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch('/dsh-ssh-manager/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  const value = await response.json() as T | { error: string }
  if (!response.ok) throw new Error((value as { error: string }).error)
  return value as T
}

export function loadSshState(): Promise<SshManagerState> { return sshApi('state') }
