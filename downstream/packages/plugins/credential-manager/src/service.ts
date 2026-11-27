/**
 * Host-only credential lookup for other DSH plugins.
 *
 * The service is registered with `ctx.provide('credentialManager', ...)`, so it
 * lives inside the Host process: neither the browser nor a model tool can reach
 * it. Metadata is the only thing listing returns; `readSecret` is the single
 * value-returning method and its caller must already have matched the credential
 * to a site. Nothing here writes an audit event or a log line containing a value.
 *
 * @module service
 */

import { CredentialError, notFoundError } from './errors.ts'
import type { CredentialManagerStore } from './store.ts'
import type { CredentialSummary } from './types.ts'

/** Cockpit credential families the external login broker can use. */
export type SiteCredentialType = 'http' | 'custom'

/** One site-scoped credential query; the origin is an absolute HTTPS origin. */
export interface CredentialSiteQuery {
  type: SiteCredentialType
  /** Target origin such as `https://crm.example.com`. */
  origin: string
}

/** Metadata-only view of a credential that matches one external site. */
export interface CredentialSiteOption {
  id: string
  name: string
  type: CredentialSummary['type']
  authKind: string
  /** Non-secret login name from `config.username`, when present. */
  username: string | null
  /** Credential endpoint origin, always equal to the queried site origin. */
  origin: string
  tags: string[]
  secretConfigured: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    credentialManager: CredentialManagerHostService
  }
}

/** The Host-only surface exposed as `ctx.credentialManager`. */
export interface CredentialManagerHostService {
  /**
   * List enabled credentials of one type whose endpoint origin matches the site.
   * @param query - cockpit credential type and site origin.
   * @returns Metadata only, sorted by name.
   */
  listForSite(query: CredentialSiteQuery): Promise<CredentialSiteOption[]>

  /**
   * Resolve one credential and prove it still matches the site.
   * @param credentialId - credential manager id chosen by the user.
   * @param query - cockpit credential type and site origin.
   * @returns Metadata only.
   */
  describeForSite(credentialId: string, query: CredentialSiteQuery): Promise<CredentialSiteOption>

  /**
   * Read the encrypted values for one credential.
   *
   * Host-only: callers must keep the result inside the Host process, never log
   * it, never place it in an audit event, and never return it to a browser or
   * model. Matching the credential to a site first is the caller's obligation.
   * @param credentialId - credential manager id.
   * @returns Secret field names mapped to values, or `undefined` when unset.
   */
  readSecret(credentialId: string): Promise<Record<string, string> | undefined>
}

/** Normalize and validate one site query before any credential is read. */
function normalizeSiteQuery(query: CredentialSiteQuery): CredentialSiteQuery {
  if (query.type !== 'http' && query.type !== 'custom') {
    throw new CredentialError('Unsupported external credential type: ' + String(query.type), {
      status: 400,
      code: 'unsupported_credential_type',
    })
  }
  let url: URL
  try {
    url = new URL(query.origin)
  } catch {
    throw new CredentialError('External site origin is not a valid URL', { status: 400, code: 'invalid_origin' })
  }
  if (url.protocol !== 'https:') {
    throw new CredentialError('External site origin must use HTTPS', { status: 400, code: 'invalid_origin' })
  }
  return { type: query.type, origin: url.origin }
}

/** Read the non-secret endpoint configured on a credential. */
function endpointOriginOf(summary: CredentialSummary): string | null {
  for (const key of ['baseUrl', 'endpoint'] as const) {
    const value = summary.config[key]
    if (typeof value !== 'string' || value.trim() === '') continue
    try {
      const url = new URL(value)
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin
    } catch {
      // A malformed endpoint makes the credential unusable for site matching.
    }
  }
  return null
}

/** Project one stored credential to the site-scoped metadata view. */
export function credentialSiteOption(summary: CredentialSummary): CredentialSiteOption | null {
  if (!summary.enabled) return null
  const origin = endpointOriginOf(summary)
  if (origin === null) return null
  const username = summary.config.username
  return {
    id: summary.id,
    name: summary.name,
    type: summary.type,
    authKind: summary.authKind,
    username: typeof username === 'string' && username.trim() !== '' ? username.trim() : null,
    origin,
    tags: [...summary.tags],
    secretConfigured: summary.secretConfigured,
  }
}

/**
 * Build the Host-only service around an existing store.
 * @param store - the credential manager store (metadata + encrypted values).
 * @returns The service value registered with `ctx.provide`.
 */
export function createCredentialHostService(store: CredentialManagerStore): CredentialManagerHostService {
  return {
    async listForSite(query) {
      const safe = normalizeSiteQuery(query)
      const state = await store.state()
      return state.credentials
        .map(credentialSiteOption)
        .filter((option): option is CredentialSiteOption =>
          option !== null && option.type === safe.type && option.origin === safe.origin)
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 50)
    },

    async describeForSite(credentialId, query) {
      const safe = normalizeSiteQuery(query)
      const summary = await store.get(credentialId)
      const option = credentialSiteOption(summary)
      if (option === null || option.type !== safe.type || option.origin !== safe.origin) {
        throw new CredentialError('Credential does not match this external site', {
          status: 404,
          code: 'credential_not_available',
        })
      }
      return option
    },

    async readSecret(credentialId) {
      if (credentialId.trim() === '') throw notFoundError(credentialId)
      const summary = await store.get(credentialId)
      if (!summary.enabled) {
        throw new CredentialError('Credential is disabled', { status: 404, code: 'credential_not_available' })
      }
      return store.readSecret(credentialId)
    },
  }
}