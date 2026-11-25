import { defaultAuthKind, defaultConfigFor, describeEndpoint, templateFor } from '../templates.ts'
import type { CredentialConfigValue, CredentialDraft, CredentialSecretInput, CredentialSummary, CredentialType } from '../types.ts'

export type PaneView =
  | { kind: 'list' }
  | { kind: 'detail'; id: string }
  | { kind: 'form'; id?: string }

export function initialDraft(existing?: CredentialSummary): CredentialDraft {
  const type: CredentialType = existing?.type ?? 'prefect'
  return {
    id: existing?.id,
    name: existing?.name ?? '',
    type,
    description: existing?.description ?? '',
    tags: existing?.tags ?? [],
    enabled: existing?.enabled ?? true,
    authKind: existing?.authKind ?? defaultAuthKind(type),
    config: existing?.config ?? defaultConfigFor(type),
    secretRef: existing?.secretRef ?? null,
  }
}

/** Empty inputs mean "keep the current secret"; only non-empty values are sent. */
export function nonEmptySecrets(secret: CredentialSecretInput): CredentialSecretInput {
  const values: CredentialSecretInput = {}
  for (const [key, value] of Object.entries(secret)) if (value !== '') values[key] = value
  return values
}

export function parseTags(text: string): string[] {
  const tags: string[] = []
  for (const part of text.split(',')) {
    const tag = part.trim()
    if (tag !== '' && !tags.includes(tag)) tags.push(tag)
  }
  return tags
}

export function filterCredentials(credentials: CredentialSummary[], query: string, type: CredentialType | 'all'): CredentialSummary[] {
  const search = query.trim().toLocaleLowerCase()
  return credentials.filter(meta => {
    if (type !== 'all' && meta.type !== type) return false
    if (search === '') return true
    return [meta.name, meta.description, meta.type, ...meta.tags].some(value => value.toLocaleLowerCase().includes(search))
  })
}

export function endpointOf(meta: CredentialSummary): string {
  return describeEndpoint(meta)
}

export function authLabel(type: CredentialType, authKind: string): string {
  const template = templateFor(type)
  return template.authMethods.find(method => method.value === authKind)?.label ?? authKind
}

export function configValueLabel(value: CredentialConfigValue | undefined): string {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'boolean') return value ? '✓' : '—'
  return String(value)
}

export function timeLabel(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return '—'
  return new Date(timestamp).toLocaleString()
}