/**
 * Metadata CRUD plus the encrypted-secret half.
 *
 * Division of labour:
 * - this file owns the plain JSON inventory (`~/.dsh/credential-manager.json`),
 *   which never receives a secret value;
 * - a {@link SecretBackend} owns the write-only values. The shared encrypted
 *   Workbench vault is the production backend because it encrypts values at
 *   rest; the DSH `ctx.credentials` grant-record seam remains available as an
 *   alternative for a Host whose provider guarantees encryption, and is always
 *   used to describe `secretRef` references;
 * - list/get return {@link CredentialMeta} only, and `readSecret` is Host-only
 *   and intentionally absent from the HTTP map and the model tools.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { credentialKey, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { CredentialError, conflictError, notFoundError, validationError } from './errors.ts'
import { authMethodFor, isCredentialType, templateFor } from './templates.ts'
import type {
  CredentialAuditEvent,
  CredentialConfig,
  CredentialDraft,
  CredentialManagerState,
  CredentialMeta,
  CredentialSecretInput,
  CredentialSummary,
  CredentialTestCheck,
  CredentialTestResult,
  CredentialType,
} from './types.ts'
import { assertRequiredSecrets, assertSameType, normalizeDraft, normalizeSecrets, sanitizeMetaForOutput } from './validation.ts'

export interface CredentialRecordProvider {
  describeRecord(key: CredentialKey): Promise<{ configured: boolean }>
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>
  modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined>
  deleteRecord(key: CredentialKey): Promise<void>
}

export interface EncryptedVault {
  has(namespace: string, id: string): Promise<boolean>
  get<T extends Record<string, unknown>>(namespace: string, id: string): Promise<T | undefined>
  set(namespace: string, id: string, value: Record<string, unknown>): Promise<void>
  delete(namespace: string, id: string): Promise<void>
}

interface SecretBackend {
  describe(id: string): Promise<{ configured: boolean }>
  read(id: string): Promise<Record<string, string> | undefined>
  write(id: string, values: Record<string, string>): Promise<void>
  delete(id: string): Promise<void>
}

interface StoredData {
  version: 1
  credentials: CredentialMeta[]
}

export interface CredentialStoreOptions {
  dataFile?: string
  credentials?: CredentialRecordProvider
  vault?: EncryptedVault
  now?: () => number
  audit?: (event: CredentialAuditEvent) => void
  /** Resolves a DSH credential reference name without revealing its value. */
  describeReference?: (reference: string) => Promise<{ configured: boolean }>
}

export interface CredentialUpdateInput {
  name?: string
  description?: string
  tags?: string[]
  enabled?: boolean
  authKind?: string
  config?: CredentialConfig
  secretRef?: string | null
}

export interface DeleteConfirmation {
  confirmed: boolean
  /** Must equal the credential's current name; typing it is the explicit human confirmation. */
  name: string
}

export interface DeleteResult {
  deleted: true
  secretCleanup: 'deleted' | 'failed'
}

const CREDENTIAL_REFERENCE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const SECRET_SCOPE = 'credential-manager'
const VAULT_NAMESPACE = 'credential-manager'

function secretRecordKey(credentialId: string): CredentialKey {
  const digest = createHash('sha256').update(credentialId).digest('hex').slice(0, 32)
  return credentialKey(SECRET_SCOPE, 'cred-' + digest)
}

function payloadValues(record: CredentialRecord | undefined): Record<string, string> {
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null || Array.isArray(record.payload)) return {}
  const payload = record.payload as Record<string, unknown>
  const values = payload.values
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (typeof value === 'string' && value !== '') result[key] = value
  }
  return result
}

class CredentialRecordBackend implements SecretBackend {
  constructor(private readonly provider: CredentialRecordProvider) {}

  async describe(id: string): Promise<{ configured: boolean }> {
    return this.provider.describeRecord(secretRecordKey(id))
  }

  async read(id: string): Promise<Record<string, string> | undefined> {
    const values = payloadValues(await this.provider.readRecord(secretRecordKey(id)))
    return Object.keys(values).length === 0 ? undefined : values
  }

  async write(id: string, values: Record<string, string>): Promise<void> {
    const key = secretRecordKey(id)
    await this.provider.modifyRecord(key, async current => ({
      kind: 'grant',
      payload: { values: { ...payloadValues(current), ...values } },
    }))
  }

  async delete(id: string): Promise<void> {
    await this.provider.deleteRecord(secretRecordKey(id))
  }
}

class VaultSecretBackend implements SecretBackend {
  constructor(private readonly vault: EncryptedVault) {}

  async describe(id: string): Promise<{ configured: boolean }> {
    return { configured: await this.vault.has(VAULT_NAMESPACE, id) }
  }

  async read(id: string): Promise<Record<string, string> | undefined> {
    const record = await this.vault.get<{ values?: Record<string, unknown> }>(VAULT_NAMESPACE, id)
    const values = record?.values
    if (typeof values !== 'object' || values === null) return undefined
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(values)) if (typeof value === 'string' && value !== '') result[key] = value
    return Object.keys(result).length === 0 ? undefined : result
  }

  async write(id: string, values: Record<string, string>): Promise<void> {
    const current = (await this.read(id)) ?? {}
    await this.vault.set(VAULT_NAMESPACE, id, { values: { ...current, ...values } })
  }

  async delete(id: string): Promise<void> {
    await this.vault.delete(VAULT_NAMESPACE, id)
  }
}

function defaultDataFile(): string {
  return join(process.env.HOME ?? process.cwd(), '.dsh', 'credential-manager.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeStoredMeta(value: unknown): CredentialMeta | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.id !== 'string' || value.id === '') return undefined
  if (typeof value.name !== 'string' || value.name === '') return undefined
  if (!isCredentialType(value.type)) return undefined
  const template = templateFor(value.type)
  const config: CredentialConfig = {}
  if (isRecord(value.config)) {
    for (const field of template.configFields) {
      const candidate = value.config[field.key]
      if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean' || candidate === null) {
        config[field.key] = candidate
      }
    }
  }
  const authKind = typeof value.authKind === 'string' && template.authMethods.some(method => method.value === value.authKind)
    ? value.authKind
    : template.authMethods[0]?.value ?? 'custom'
  return {
    id: value.id,
    name: value.name,
    type: value.type,
    description: typeof value.description === 'string' ? value.description : '',
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    enabled: value.enabled !== false,
    authKind,
    config,
    configuredSecretFields: Array.isArray(value.configuredSecretFields)
      ? value.configuredSecretFields.filter((field): field is string => typeof field === 'string')
      : [],
    secretRef: typeof value.secretRef === 'string' && CREDENTIAL_REFERENCE_PATTERN.test(value.secretRef) ? value.secretRef : null,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
    lastTestedAt: typeof value.lastTestedAt === 'number' ? value.lastTestedAt : null,
    lastTest: isRecord(value.lastTest) ? value.lastTest as unknown as CredentialTestResult : null,
  }
}

/** Local-only validation probe; it never opens a socket. */
export function validateCredentialForTest(
  meta: CredentialMeta,
  secretConfigured: boolean,
  referenceConfigured: boolean | undefined,
  now: number,
): CredentialTestResult {
  const checks: CredentialTestCheck[] = []
  const template = templateFor(meta.type)
  checks.push({ id: 'type', label: '类型模板', ok: true, detail: template.label })

  for (const field of template.configFields) {
    const value = meta.config[field.key]
    const present = value !== undefined && value !== null && value !== ''
    if (field.required && !present) {
      checks.push({ id: 'config.' + field.key, label: field.label, ok: false, detail: '缺少必填配置' })
      continue
    }
    if (field.type === 'url' && typeof value === 'string' && value !== '') {
      let ok = false
      try { const url = new URL(value); ok = url.protocol === 'http:' || url.protocol === 'https:' } catch { ok = false }
      checks.push({ id: 'config.' + field.key, label: field.label, ok, detail: ok ? 'http(s) 地址合法' : '地址必须是绝对 http(s) URL' })
    }
  }

  const method = authMethodFor(template, meta.authKind)
  if (method.requiredSecrets.length === 0) {
    checks.push({ id: 'secret', label: '密钥', ok: true, detail: '当前认证方式无需密钥' })
  } else if (meta.secretRef !== null) {
    const ok = referenceConfigured !== false
    checks.push({
      id: 'secret',
      label: '密钥',
      ok,
      detail: ok
        ? referenceConfigured === true ? '引用的 DSH 凭据已配置' : '引用名称合法；未连接凭据服务做在线校验'
        : '引用的 DSH 凭据未配置',
    })
  } else {
    const missing = method.requiredSecrets.filter(field => !meta.configuredSecretFields.includes(field))
    checks.push({
      id: 'secret',
      label: '密钥',
      ok: secretConfigured && missing.length === 0,
      detail: !secretConfigured ? '加密凭据记录不存在' : missing.length > 0 ? '缺少密钥字段：' + missing.join(', ') : '加密凭据已配置',
    })
  }

  checks.push({ id: 'network', label: '网络探测', ok: true, detail: 'MVP 仅做本地配置校验，未发起网络连接' })
  return { ok: checks.every(check => check.ok), mode: 'validation', checkedAt: now, networkAttempted: false, checks }
}

export class CredentialManagerStore {
  readonly dataFile: string
  private readonly backend: SecretBackend
  private readonly now: () => number
  private readonly audit: (event: CredentialAuditEvent) => void
  private readonly describeReference: ((reference: string) => Promise<{ configured: boolean }>) | undefined
  private data: StoredData | undefined
  private mutations: Promise<void> = Promise.resolve()

  constructor(options: CredentialStoreOptions) {
    this.dataFile = options.dataFile ?? defaultDataFile()
    // Vault wins when both are supplied: it is the AES-GCM store. The credentials
    // seam is then only used for `secretRef` description in `apply`.
    if (options.vault !== undefined) this.backend = new VaultSecretBackend(options.vault)
    else if (options.credentials !== undefined) this.backend = new CredentialRecordBackend(options.credentials)
    else throw new Error('CredentialManagerStore requires an encrypted vault or a credentials provider')
    this.now = options.now ?? (() => Date.now())
    this.audit = options.audit ?? (() => undefined)
    this.describeReference = options.describeReference
  }

  private emit(event: CredentialAuditEvent): void {
    try { this.audit(event) } catch { /* auditing must never break a committed operation */ }
  }

  private async load(): Promise<StoredData> {
    if (this.data !== undefined) return this.data
    await mkdir(dirname(this.dataFile), { recursive: true })
    if (!existsSync(this.dataFile)) {
      this.data = { version: 1, credentials: [] }
      return this.data
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.dataFile, 'utf8'))
    } catch {
      throw new Error('Credential Manager metadata is not valid JSON: ' + this.dataFile)
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.credentials)) {
      throw new Error('Unsupported Credential Manager data format: ' + this.dataFile)
    }
    this.data = {
      version: 1,
      credentials: parsed.credentials.map(normalizeStoredMeta).filter((meta): meta is CredentialMeta => meta !== undefined),
    }
    return this.data
  }

  private async persist(): Promise<void> {
    if (this.data === undefined) throw new Error('Credential Manager data is not loaded')
    const temporary = this.dataFile + '.next-' + process.pid.toString()
    await writeFile(temporary, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.dataFile)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation, operation)
    this.mutations = result.then(() => undefined, () => undefined)
    return result
  }

  private async configuredSecret(id: string): Promise<boolean> {
    try { return (await this.backend.describe(id)).configured } catch { return false }
  }

  private async summarize(meta: CredentialMeta): Promise<CredentialSummary> {
    const sanitized = sanitizeMetaForOutput({ ...meta, config: { ...meta.config }, tags: [...meta.tags], configuredSecretFields: [...meta.configuredSecretFields] })
    return { ...sanitized, secretConfigured: await this.configuredSecret(meta.id) }
  }

  async state(): Promise<CredentialManagerState> {
    await this.mutations
    const data = await this.load()
    return { version: 1, credentials: await Promise.all(data.credentials.map(meta => this.summarize(meta))) }
  }

  async list(filter: { type?: CredentialType; search?: string; enabled?: boolean } = {}): Promise<CredentialSummary[]> {
    const state = await this.state()
    const search = filter.search?.trim().toLocaleLowerCase()
    return state.credentials.filter(meta => {
      if (filter.type !== undefined && meta.type !== filter.type) return false
      if (filter.enabled !== undefined && meta.enabled !== filter.enabled) return false
      if (search === undefined || search === '') return true
      return [meta.name, meta.description, meta.type, ...meta.tags].some(value => value.toLocaleLowerCase().includes(search))
    })
  }

  async get(id: string): Promise<CredentialSummary> {
    const state = await this.state()
    const meta = state.credentials.find(item => item.id === id)
    if (meta === undefined) throw notFoundError(id)
    return meta
  }

  async create(draft: CredentialDraft, secret?: CredentialSecretInput): Promise<CredentialSummary> {
    return this.enqueue(async () => {
      const data = await this.load()
      const normalized = normalizeDraft(draft, { existingNames: data.credentials.map(meta => meta.name) })
      const values = normalizeSecrets(normalized.template, normalized.authMethod, secret)
      if (normalized.secretRef !== null && Object.keys(values).length > 0) {
        throw validationError('Provide either secret or secret_ref, not both')
      }
      assertRequiredSecrets(normalized.authMethod, Object.keys(values), normalized.secretRef)

      const id = randomUUID()
      const timestamp = this.now()
      const meta: CredentialMeta = {
        id,
        name: normalized.name,
        type: normalized.type,
        description: normalized.description,
        tags: normalized.tags,
        enabled: normalized.enabled,
        authKind: normalized.authKind,
        config: normalized.config,
        configuredSecretFields: Object.keys(values),
        secretRef: normalized.secretRef,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastTestedAt: null,
        lastTest: null,
      }
      if (Object.keys(values).length > 0) await this.backend.write(id, values)
      data.credentials.push(meta)
      try {
        await this.persist()
      } catch (error) {
        if (Object.keys(values).length > 0) await this.backend.delete(id).catch(() => undefined)
        data.credentials = data.credentials.filter(item => item.id !== id)
        throw error
      }
      this.emit({ action: 'create', credentialId: id, name: meta.name, type: meta.type, detail: { secretFields: Object.keys(values), secretRef: meta.secretRef } })
      return this.summarize(meta)
    })
  }

  async update(id: string, patch: CredentialUpdateInput, secret?: CredentialSecretInput): Promise<CredentialSummary> {
    return this.enqueue(async () => {
      const data = await this.load()
      const index = data.credentials.findIndex(item => item.id === id)
      if (index === -1) throw notFoundError(id)
      const existing = data.credentials[index] as CredentialMeta
      const candidateType = (patch as CredentialDraft).type
      if (candidateType !== undefined) assertSameType(existing.type, candidateType)

      const draft: CredentialDraft = {
        id,
        name: patch.name ?? existing.name,
        type: existing.type,
        description: patch.description ?? existing.description,
        tags: patch.tags ?? existing.tags,
        enabled: patch.enabled ?? existing.enabled,
        authKind: patch.authKind ?? existing.authKind,
        config: patch.config ?? existing.config,
        secretRef: patch.secretRef === undefined ? existing.secretRef : patch.secretRef,
      }
      const normalized = normalizeDraft(draft, { existingNames: data.credentials.map(meta => meta.name), currentName: existing.name })
      const values = normalizeSecrets(normalized.template, normalized.authMethod, secret)
      if (normalized.secretRef !== null && Object.keys(values).length > 0) {
        throw validationError('Provide either secret or secret_ref, not both')
      }

      // Only names that belong to the newly selected auth method count as configured.
      const kept = existing.configuredSecretFields.filter(field => normalized.authMethod.secretFields.includes(field))
      const configuredSecretFields = [...new Set([...kept, ...Object.keys(values)])]
      assertRequiredSecrets(normalized.authMethod, configuredSecretFields, normalized.secretRef)

      if (Object.keys(values).length > 0) await this.backend.write(id, values)
      if (normalized.secretRef !== null) {
        await this.backend.delete(id)
        configuredSecretFields.length = 0
      }

      const meta: CredentialMeta = {
        ...existing,
        name: normalized.name,
        description: normalized.description,
        tags: normalized.tags,
        enabled: normalized.enabled,
        authKind: normalized.authKind,
        config: normalized.config,
        configuredSecretFields,
        secretRef: normalized.secretRef,
        updatedAt: this.now(),
      }
      data.credentials[index] = meta
      try {
        await this.persist()
      } catch (error) {
        data.credentials[index] = existing
        throw error
      }
      this.emit({
        action: 'update',
        credentialId: id,
        name: meta.name,
        type: meta.type,
        detail: {
          fields: Object.keys(patch).filter(key => patch[key as keyof CredentialUpdateInput] !== undefined),
          secretFields: Object.keys(values),
          secretRef: meta.secretRef,
        },
      })
      return this.summarize(meta)
    })
  }

  async setEnabled(id: string, enabled: boolean): Promise<CredentialSummary> {
    return this.update(id, { enabled })
  }

  async delete(id: string, confirmation: DeleteConfirmation): Promise<DeleteResult> {
    return this.enqueue(async () => {
      const data = await this.load()
      const index = data.credentials.findIndex(item => item.id === id)
      if (index === -1) throw notFoundError(id)
      const meta = data.credentials[index] as CredentialMeta
      if (confirmation.confirmed !== true) throw validationError('Deleting a credential requires explicit confirmation')
      if (confirmation.name !== meta.name) throw validationError('Confirmation name does not match the credential name')
      // Remove the encrypted secret first: a failure here aborts the whole
      // deletion, so the inventory never points at a credential whose secret
      // removal silently failed.
      try {
        await this.backend.delete(id)
      } catch {
        throw new CredentialError('Could not remove the encrypted secret; the credential was not deleted', { status: 500, code: 'secret_cleanup_failed' })
      }
      data.credentials.splice(index, 1)
      try {
        await this.persist()
      } catch (error) {
        data.credentials.splice(index, 0, meta)
        throw error
      }
      this.emit({ action: 'delete', credentialId: id, name: meta.name, type: meta.type, detail: { secretCleanup: 'deleted' } })
      return { deleted: true, secretCleanup: 'deleted' }
    })
  }

  async test(id: string): Promise<CredentialTestResult> {
    return this.enqueue(async () => {
      const data = await this.load()
      const meta = data.credentials.find(item => item.id === id)
      if (meta === undefined) throw notFoundError(id)
      const secretConfigured = await this.configuredSecret(id)
      let referenceConfigured: boolean | undefined
      if (meta.secretRef !== null && this.describeReference !== undefined) {
        try { referenceConfigured = (await this.describeReference(meta.secretRef)).configured } catch { referenceConfigured = false }
      }
      const result = validateCredentialForTest(meta, secretConfigured, referenceConfigured, this.now())
      meta.lastTestedAt = result.checkedAt
      meta.lastTest = result
      meta.updatedAt = result.checkedAt
      await this.persist()
      this.emit({ action: 'test', credentialId: id, name: meta.name, type: meta.type, detail: { ok: result.ok } })
      return result
    })
  }

  /**
   * Host-only secret read for a future connector. Never register this on the
   * HTTP map or as a model tool. The values must not be logged, cached in
   * client state, or returned to a model.
   */
  async readSecret(id: string): Promise<Record<string, string> | undefined> {
    await this.get(id)
    return this.backend.read(id)
  }
}

/** Re-exported for tests and for the Host API's delete route. */
export { conflictError }