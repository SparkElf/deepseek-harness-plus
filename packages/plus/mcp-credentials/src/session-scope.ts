/**
 * The Session one MCP call belongs to, carried to the credential resolver.
 *
 * A workspace has one DataOps identity, so an ordinary conversation resolves the workspace
 * credential. A group-chat room acts for one member instead: its Session carries that member as an
 * opaque actor, and the connector mints a scoped credential for it. The resolver runs inside the
 * MCP SDK's fetch, far from the tool call that started it, so the identity travels through async
 * local storage rather than a parameter chain.
 *
 * @module session-scope
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** The identity a scoped credential is minted for. */
export interface McpSessionIdentity {
  /** Session id, used to name the scoped credential entry. */
  readonly sessionId: string
  /** Opaque actor; only its presence matters here, the connector interprets it. */
  readonly actor: unknown
}

/** Ambient identity of the MCP call being served; empty outside a Session with an actor. */
export const sessionScope = new AsyncLocalStorage<McpSessionIdentity>()

/**
 * Run one tool call with its Session visible to credential resolution.
 * @param identity - the call's Session identity, or undefined for an ordinary conversation.
 * @param work - the call body.
 * @returns the body's result.
 */
export function runWithSession<T>(identity: McpSessionIdentity | undefined, work: () => Promise<T>): Promise<T> {
  return identity === undefined ? work() : sessionScope.run(identity, work)
}

/**
 * Name the scoped credential entry one Session uses.
 *
 * Credential references are uppercase underscore tokens, so the Session id is folded into that
 * alphabet: `group-room-<uuid>` becomes `GROUP_ROOM_<UUID>`. Two ids that differ only in
 * punctuation therefore share an entry, which is why the connector mints entries from the same
 * function rather than formatting the name itself.
 * @param baseRef - the workspace credential reference.
 * @param sessionId - the Session's id.
 * @returns the scoped reference for that Session.
 */
export function scopedCredentialRef(baseRef: string, sessionId: string): string {
  const suffix = sessionId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `${baseRef}_S_${suffix}`
}