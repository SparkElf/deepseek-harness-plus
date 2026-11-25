/**
 * Reserved connector seam — design only, not implemented in this MVP.
 *
 * The inventory is deliberately not a network proxy. A future connector must
 * take a credential id, resolve the secret inside the Host, and perform one
 * operation the credential's own configuration declares. It must never accept a
 * model-supplied URL and fetch it, which is the SSRF shape this MVP refuses to
 * ship.
 *
 * Requirements a future implementation must satisfy before these interfaces may
 * be wired to tools:
 * - the operation shape comes from the credential template, not from free-form
 *   model input; `credential_request` may choose an operation and path suffix,
 *   never a new origin;
 * - scheme, host, and port come from stored metadata and are checked against a
 *   deployment allowlist;
 * - redirects are disabled, DNS results are checked against loopback, link-local,
 *   private, and metadata ranges on every hop, and the connection is pinned to
 *   the checked address;
 * - response bytes and time are capped, and the result is redacted before it
 *   reaches a model;
 * - `credential_db_query` allows only read-only statements, one statement, a row
 *   cap, and a timeout, and returns column metadata plus capped rows;
 * - both operations require explicit approval and write an audit event that
 *   excludes secrets and full result bodies.
 */

export interface CredentialRequestInput {
  credentialId: string
  /** Logical operation declared by the credential's template, not a raw URL. */
  operation: string
  /** Path suffix relative to the configured base URL; the origin is never model-controlled. */
  path?: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: Record<string, string>
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface CredentialRequestResult {
  status: number
  headers: Record<string, string>
  body: string
  bodyTruncated: boolean
  durationMs: number
}

export interface CredentialDbQueryInput {
  credentialId: string
  /** One read-only statement; the future adapter rejects anything else. */
  sql: string
  params?: readonly unknown[]
  maxRows?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface CredentialDbQueryResult {
  columns: { name: string; type?: string }[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
  durationMs: number
}

/** Not registered as a tool in this MVP. */
export interface CredentialRequestSeam {
  request(input: CredentialRequestInput): Promise<CredentialRequestResult>
}

/** Not registered as a tool in this MVP. */
export interface CredentialDbQuerySeam {
  query(input: CredentialDbQueryInput): Promise<CredentialDbQueryResult>
}

export const RESERVED_CONNECTOR_STATUS = {
  implemented: false,
  reason: 'MVP intentionally ships no arbitrary network or database proxy; see connectors.ts for the security requirements.',
  plannedTools: ['credential_request', 'credential_db_query'],
} as const

export function reservedConnectorError(operation: string): Error {
  return new Error(operation + ' is reserved for a later connector milestone and is not implemented in this MVP')
}