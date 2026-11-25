/**
 * Validation for credential drafts and write-only secret payloads.
 *
 * Every message names fields, never values, so a rejected call cannot echo a
 * secret back into a tool result or a log line.
 */
import { conflictError, CredentialError, validationError } from './errors.ts'
import { authMethodFor, defaultConfigFor, isCredentialType, templateFor } from './templates.ts'
import type {
  CredentialAuthMethod,
  CredentialConfig,
  CredentialConfigValue,
  CredentialDraft,
  CredentialSecretInput,
  CredentialTemplate,
  CredentialType,
} from './types.ts'

const NAME_MAX = 80
const DESCRIPTION_MAX = 500
const TAG_MAX = 40
const TAGS_MAX = 20
const URL_MAX = 2000
const TEXT_MAX = 500
const SECRET_MAX = 8192
const PRIVATE_KEY_MAX = 65_536
const REF_MAX = 128

/**
 * Field names that must never appear in the plain metadata half. Compared after
 * lowercasing and dropping `-`/`_`, so `apiKey`, `api-key`, and `API_KEY` all
 * match while `secretLabel` and `tokenUrl` do not.
 */
const SENSITIVE_CONFIG_KEYS = new Set([
  'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'apisecret',
  'privatekey', 'authorization', 'credential', 'credentials', 'accesskey',
  'secretkey', 'bearer', 'cookie', 'sessionkey',
])

const REFERENCE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface NormalizedDraft {
  name: string
  type: CredentialType
  description: string
  tags: string[]
  enabled: boolean
  authKind: string
  config: CredentialConfig
  secretRef: string | null
  template: CredentialTemplate
  authMethod: CredentialAuthMethod
}

export interface NormalizeDraftOptions {
  /** Names already in use, for create and rename checks. */
  existingNames?: readonly string[]
  /** The current name when updating, so an unchanged name is not a duplicate. */
  currentName?: string
}

export function normalizeDraft(input: CredentialDraft, options: NormalizeDraftOptions = {}): NormalizedDraft {
  if (typeof input !== 'object' || input === null) throw validationError('Credential draft must be an object')
  if (!isCredentialType(input.type)) throw validationError('Credential type must be one of: prefect, dataops, database, http, ssh, custom')

  const template = templateFor(input.type)
  const name = requireText(input.name, 'name', NAME_MAX)
  const duplicate = (options.existingNames ?? [])
    .map(candidate => candidate.toLocaleLowerCase())
    .includes(name.toLocaleLowerCase()) && name.toLocaleLowerCase() !== (options.currentName ?? '').toLocaleLowerCase()
  if (duplicate) throw conflictError('A credential named "' + name + '" already exists')

  const authMethod = authMethodFor(template, input.authKind)
  const description = optionalText(input.description, 'description', DESCRIPTION_MAX)
  const tags = normalizeTags(input.tags)
  const config = normalizeConfig(input.type, template, input.config, authMethod)
  const secretRef = normalizeSecretRef(input.secretRef)

  return {
    name,
    type: input.type,
    description,
    tags,
    enabled: input.enabled ?? true,
    authKind: authMethod.value,
    config,
    secretRef,
    template,
    authMethod,
  }
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw validationError('Credential ' + field + ' is required')
  const text = value.trim()
  if (text === '') throw validationError('Credential ' + field + ' is required')
  if (text.length > max) throw validationError('Credential ' + field + ' must be at most ' + String(max) + ' characters')
  if (/[\u0000-\u001f\u007f]/.test(text)) throw validationError('Credential ' + field + ' contains control characters')
  return text
}

function optionalText(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw validationError('Credential ' + field + ' must be a string')
  const text = value.trim()
  if (text.length > max) throw validationError('Credential ' + field + ' must be at most ' + String(max) + ' characters')
  if (/[\u0000-\u001f\u007f]/.test(text)) throw validationError('Credential ' + field + ' contains control characters')
  return text
}

function normalizeTags(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw validationError('Credential tags must be an array of strings')
  if (value.length > TAGS_MAX) throw validationError('Credential tags must contain at most ' + String(TAGS_MAX) + ' entries')
  const tags: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw validationError('Credential tags must be an array of strings')
    const tag = item.trim()
    if (tag === '') continue
    if (tag.length > TAG_MAX) throw validationError('Each credential tag must be at most ' + String(TAG_MAX) + ' characters')
    if (!tags.includes(tag)) tags.push(tag)
  }
  return tags
}

function normalizeSecretRef(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw validationError('Credential secret_ref must be a string')
  const ref = value.trim()
  if (ref === '') return null
  if (ref.length > REF_MAX) throw validationError('Credential secret_ref must be at most ' + String(REF_MAX) + ' characters')
  if (!REFERENCE_PATTERN.test(ref)) throw validationError('Credential secret_ref must be a POSIX environment variable name')
  return ref
}

function normalizeConfig(type: CredentialType, template: CredentialTemplate, value: unknown, authMethod: CredentialAuthMethod): CredentialConfig {
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw validationError('Credential config must be an object')
  }
  const supplied = (value ?? {}) as Record<string, unknown>
  const known = new Set(template.configFields.map(field => field.key))
  for (const key of Object.keys(supplied)) {
    if (!known.has(key)) throw validationError('Unknown config field for ' + type + ': ' + key)
  }

  const defaults = defaultConfigFor(type)
  const config: CredentialConfig = {}
  for (const field of template.configFields) {
    const raw = Object.prototype.hasOwnProperty.call(supplied, field.key) ? supplied[field.key] : defaults[field.key]
    if (raw === undefined || raw === null || raw === '') {
      if (field.required) throw validationError('Credential config.' + field.key + ' is required')
      config[field.key] = field.type === 'boolean' ? false : field.type === 'number' ? 0 : ''
      continue
    }
    if (field.type === 'boolean') {
      if (typeof raw !== 'boolean') throw validationError('Credential config.' + field.key + ' must be a boolean')
      config[field.key] = raw
      continue
    }
    if (field.type === 'number') {
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
      if (!Number.isFinite(number) || !Number.isInteger(number) || number <= 0) {
        throw validationError('Credential config.' + field.key + ' must be a positive integer')
      }
      if (field.key === 'port' && number > 65_535) throw validationError('Credential config.port must be between 1 and 65535')
      if (field.key === 'timeoutMs' && (number < 100 || number > 120_000)) throw validationError('Credential config.timeoutMs must be between 100 and 120000')
      config[field.key] = number
      continue
    }
    if (typeof raw !== 'string') throw validationError('Credential config.' + field.key + ' must be a string')
    const text = raw.trim()
    if (text.length > (field.type === 'url' ? URL_MAX : TEXT_MAX)) throw validationError('Credential config.' + field.key + ' is too long')
    if (text === '') {
      if (field.required) throw validationError('Credential config.' + field.key + ' is required')
      config[field.key] = ''
      continue
    }
    if (field.type === 'select' && !(field.options ?? []).some(option => option.value === text)) {
      throw validationError('Credential config.' + field.key + ' must be one of the supported values')
    }
    if (field.type === 'url') assertHttpUrl(text, 'config.' + field.key)
    if (isSensitiveKey(field.key)) throw validationError('Credential config.' + field.key + ' looks sensitive; use a secret field instead')
    if (text.includes('-----BEGIN')) throw validationError('Credential config.' + field.key + ' looks like key material; use a secret field instead')
    config[field.key] = text
  }

  if (type === 'http') {
    if (authMethod.value === 'basic' && (typeof config.username !== 'string' || config.username === '')) {
      throw validationError('Credential config.username is required for HTTP Basic authentication')
    }
    if (authMethod.value === 'header' && (typeof config.headerName !== 'string' || config.headerName === '')) {
      throw validationError('Credential config.headerName is required for header authentication')
    }
  }
  if (type === 'prefect' && authMethod.value === 'basic' && (typeof config.username !== 'string' || config.username === '')) {
    throw validationError('Credential config.username is required for Prefect Basic authentication')
  }
  return config
}

function assertHttpUrl(value: string, field: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw validationError('Credential ' + field + ' must be an absolute http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw validationError('Credential ' + field + ' must use http or https')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw validationError('Credential ' + field + ' must not contain embedded credentials')
  }
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_CONFIG_KEYS.has(key.toLocaleLowerCase().replace(/[-_]/g, ''))
}

/**
 * Validate write-only secret values against the selected authentication method.
 * Empty strings are "keep the current value", not a request to blank a field.
 */
export function normalizeSecrets(template: CredentialTemplate, authMethod: CredentialAuthMethod, input: unknown): Record<string, string> {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) throw validationError('Credential secret must be an object of field values')
  const supplied = input as Record<string, unknown>
  const allowed = new Set(authMethod.secretFields)
  const values: Record<string, string> = {}
  for (const [key, raw] of Object.entries(supplied)) {
    if (!allowed.has(key)) throw validationError('Unknown secret field for ' + template.type + ' / ' + authMethod.value + ': ' + key)
    if (raw === undefined || raw === null || raw === '') continue
    if (typeof raw !== 'string') throw validationError('Secret field ' + key + ' must be a string')
    const max = key === 'privateKey' ? PRIVATE_KEY_MAX : SECRET_MAX
    if (raw.length > max) throw validationError('Secret field ' + key + ' is too long')
    if (raw.includes('\u0000')) throw validationError('Secret field ' + key + ' contains a null byte')
    values[key] = raw
  }
  return values
}

export function missingRequiredSecrets(authMethod: CredentialAuthMethod, configuredFields: readonly string[]): string[] {
  const configured = new Set(configuredFields)
  return authMethod.requiredSecrets.filter(field => !configured.has(field))
}

export function assertRequiredSecrets(authMethod: CredentialAuthMethod, configuredFields: readonly string[], secretRef: string | null): void {
  if (secretRef !== null) return
  const missing = missingRequiredSecrets(authMethod, configuredFields)
  if (missing.length > 0) {
    throw validationError('Credential is missing required secret fields: ' + missing.join(', '))
  }
}

/** Thrown by the HTTP layer when a user tries to switch type in place. */
export function assertSameType(current: CredentialType, next: CredentialType): void {
  if (current !== next) throw new CredentialError('Credential type cannot be changed; create a new credential instead', { status: 400, code: 'type_immutable' })
}

/** Strip anything that could only be there by bypassing validation (defense in depth). */
export function sanitizeMetaForOutput<T extends { config: CredentialConfig }>(meta: T): T {
  const config: CredentialConfig = {}
  for (const [key, value] of Object.entries(meta.config)) {
    if (isSensitiveKey(key)) continue
    if (typeof value === 'string' && value.includes('-----BEGIN')) continue
    config[key] = value
  }
  return { ...meta, config }
}

export function isConfigValue(value: unknown): value is CredentialConfigValue {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}