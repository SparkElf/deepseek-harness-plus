import type { CredentialDraft, CredentialManagerState, CredentialSecretInput, CredentialSummary, CredentialTestResult } from '../types.ts'

interface ApiError {
  error?: string
  code?: string
}

async function call<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch('/dsh-credential-manager/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  let value: unknown
  try {
    value = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new Error('Credential Manager returned a non-JSON response (' + String(response.status) + ')')
  }
  if (!response.ok) {
    const error = value as ApiError
    throw new Error(error.error ?? 'Credential Manager request failed (' + String(response.status) + ')')
  }
  return value as T
}

export function loadState(): Promise<CredentialManagerState> {
  return call<CredentialManagerState>('state')
}

export function saveCredential(credential: CredentialDraft, secret: CredentialSecretInput): Promise<CredentialSummary> {
  return call<CredentialSummary>('credentials.save', { credential, secret })
}

export function deleteCredential(credentialId: string, confirmName: string): Promise<{ deleted: true; secretCleanup: string }> {
  return call('credentials.delete', { credentialId, confirm: true, confirmName })
}

export function toggleCredential(credentialId: string, enabled: boolean): Promise<CredentialSummary> {
  return call<CredentialSummary>('credentials.toggle', { credentialId, enabled })
}

export function testCredential(credentialId: string): Promise<CredentialTestResult> {
  return call<CredentialTestResult>('credentials.test', { credentialId })
}