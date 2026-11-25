/**
 * Scoped credentials for group-chat rooms.
 *
 * A room acts for the member the connector names, so its MCP calls must not ride on the workspace
 * JWT. The connector mints one token per room Session, stores it under a Session-specific
 * credential ref, and the MCP bridge prefers that entry for the room's requests. Minting happens
 * once per room, not per request: the token shares the workspace token's long lifetime, and a
 * revoked token surfaces as a 401 the bridge retries once.
 *
 * @module scoped-credential
 */

/** The credential reference a room Session's token is stored under. */
export interface ScopedCredentialDeps {
  /** Calls one DataOps endpoint with the workspace JWT. */
  readonly request: (path: string, init?: RequestInit) => Promise<{ readonly status: number; readonly body: unknown }>
  /** Stores one credential value. */
  readonly set: (ref: string, value: string) => Promise<void>
  /** Reports a failed mint without failing the caller. */
  readonly warn: (message: string, error?: unknown) => void
}

/**
 * Fold a Session id into the credential-ref alphabet.
 *
 * Credential references are uppercase underscore tokens, and the MCP bridge derives the same name
 * from the Session id it is serving. Both sides use this function so they cannot drift.
 * @param baseRef - the workspace credential reference, for example `DATAOPS_ACCESS_TOKEN`.
 * @param sessionId - the room Session id.
 * @returns the scoped reference for that Session.
 */
export function scopedCredentialRef(baseRef: string, sessionId: string): string {
  const suffix = sessionId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `${baseRef}_S_${suffix}`
}

/**
 * Mint one room's scoped token and store it.
 *
 * Failure is reported and swallowed: the room keeps working on the workspace credential, which is
 * the pre-connector behaviour, so a backend outage degrades authority instead of breaking chat.
 * @param deps - endpoint, credential store, and logger.
 * @param baseRef - the workspace credential reference the scoped name derives from.
 * @param sessionId - the room Session the token is minted for.
 * @param actorUserId - the DataOps user the room acts for.
 * @returns the stored reference, or undefined when minting failed.
 */
export async function mintScopedCredential(
  deps: ScopedCredentialDeps,
  baseRef: string,
  sessionId: string,
  actorUserId: string,
): Promise<string | undefined> {
  const ref = scopedCredentialRef(baseRef, sessionId)
  try {
    const result = await deps.request('/api/ai/workspace/scoped-token', {
      method: 'POST',
      body: JSON.stringify({ sessionId, actorUserId }),
    })
    const token = tokenOf(result.body)
    if (result.status !== 200 || token === undefined) {
      deps.warn(`scoped credential for ${sessionId} was not minted (status ${String(result.status)})`)
      return undefined
    }
    await deps.set(ref, token)
    return ref
  } catch (error: unknown) {
    deps.warn(`scoped credential for ${sessionId} failed to mint`, error)
    return undefined
  }
}

/** Read the token out of an unknown mint response body. */
function tokenOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)['token']
  return typeof value === 'string' && value !== '' ? value : undefined
}
