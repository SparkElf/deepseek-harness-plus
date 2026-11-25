/**
 * Wire types shared by the Host, the browser bundle, and the model tools.
 *
 * The split that matters here is {@link CredentialMeta} versus
 * {@link CredentialSecretInput}: metadata is safe to list, render, log, and
 * return to a model; secret input is write-only and never comes back out of the
 * store. There is deliberately no type that carries a secret alongside
 * metadata, so an accidental "return the credential" cannot be typed.
 */

export const CREDENTIAL_TYPES = ['prefect', 'dataops', 'database', 'http', 'ssh', 'custom'] as const
export type CredentialType = (typeof CREDENTIAL_TYPES)[number]

export type CredentialConfigValue = string | number | boolean | null
export type CredentialConfig = Record<string, CredentialConfigValue>

/** A field the UI renders in the non-secret configuration half of a credential. */
export interface CredentialConfigField {
  key: string
  label: string
  type: 'text' | 'number' | 'url' | 'select' | 'boolean'
  required: boolean
  placeholder?: string
  help?: string
  options?: readonly { value: string; label: string }[]
}

/** One write-only field; only its name is ever stored outside the secret store. */
export interface CredentialSecretField {
  key: string
  label: string
  placeholder?: string
  multiline?: boolean
}

/** One authentication variant and the secrets it needs. */
export interface CredentialAuthMethod {
  value: string
  label: string
  secretFields: readonly string[]
  requiredSecrets: readonly string[]
}

export interface CredentialTemplate {
  type: CredentialType
  label: string
  description: string
  configFields: readonly CredentialConfigField[]
  secretFields: readonly CredentialSecretField[]
  authMethods: readonly CredentialAuthMethod[]
}

/** Everything the store persists in its plain JSON file. No secret values. */
export interface CredentialMeta {
  id: string
  name: string
  type: CredentialType
  description: string
  tags: string[]
  enabled: boolean
  authKind: string
  config: CredentialConfig
  /** Names of secret fields known to be configured; never their values. */
  configuredSecretFields: string[]
  /** A DSH credential reference name, itself non-secret, as an alternative to a stored secret. */
  secretRef: string | null
  createdAt: number
  updatedAt: number
  lastTestedAt: number | null
  lastTest: CredentialTestResult | null
}

/** The create/update payload accepted over the same-origin Host API. */
export interface CredentialDraft {
  id?: string
  name: string
  type: CredentialType
  description?: string
  tags?: string[]
  enabled?: boolean
  authKind?: string
  config?: CredentialConfig
  secretRef?: string | null
}

/** Write-only secret values keyed by template secret field name. */
export type CredentialSecretInput = Record<string, string>

export interface CredentialTestCheck {
  id: string
  label: string
  ok: boolean
  detail: string
}

export interface CredentialTestResult {
  ok: boolean
  /** MVP tests validate configuration locally; they never open a socket. */
  mode: 'validation'
  checkedAt: number
  networkAttempted: false
  checks: CredentialTestCheck[]
}

export interface CredentialManagerState {
  version: 1
  credentials: CredentialSummary[]
}

/** A metadata-only view plus the computed secret-presence flag. */
export type CredentialSummary = CredentialMeta & { secretConfigured: boolean }

export interface CredentialAuditEvent {
  action: 'create' | 'update' | 'delete' | 'toggle' | 'test'
  credentialId: string
  name: string
  type: CredentialType
  /** Field names only; never values. */
  detail?: Record<string, string | number | boolean | string[] | null>
}

/** Inputs to the local validation probe; exported so tests can assert its boundary. */
export interface CredentialTestInput {
  meta: CredentialMeta
  secretConfigured: boolean
  referenceConfigured?: boolean
}