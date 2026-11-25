/**
 * The room/session binding, shared by both halves of the plugin.
 *
 * The browser half needs it to open a room's Session; the host half needs it to create and
 * recognize one. It lives in its own module because the two halves are built for different
 * runtimes: importing it from the host entry would drag the whole server side into the client
 * bundle, which the build's platform guard refuses — correctly, since none of it can run there.
 *
 * @module @sparkelf/dsh-group-chat/session-id
 */

/**
 * Every room session id starts with this, so a room's session is recognizable after a restart
 * and an ordinary session never matches.
 *
 * The binding lives in the id rather than in `SessionHeader` because the header carries no
 * free-form metadata field.
 */
export const ROOM_SESSION_PREFIX = 'group-room-'

/** Deterministic session id for a room. */
export const roomSessionId = (roomId: string): string => `${ROOM_SESSION_PREFIX}${roomId}`

/**
 * Reads the room a session *id* is bound to, or `undefined` for an ordinary session.
 *
 * Separate from {@link roomIdOfSession} because the two call sites receive different things: a
 * seat hands the composer a bare id string, while a session event hands over the session object.
 * Passing a string to the object form silently returns `undefined` — it checks for an object
 * first — which is how a correctly registered composer seat ended up drawing nothing.
 */
export const roomIdOfSessionId = (sessionId: string): string | undefined => {
  if (!sessionId.startsWith(ROOM_SESSION_PREFIX)) return undefined
  const roomId = sessionId.slice(ROOM_SESSION_PREFIX.length)
  return roomId.length > 0 ? roomId : undefined
}

/** Reads the room a session is bound to, or `undefined` for an ordinary session. */
export const roomIdOfSession = (session: unknown): string | undefined => {
  if (typeof session !== 'object' || session === null) return undefined
  const id = (session as { id?: unknown }).id
  if (typeof id !== 'string' || !id.startsWith(ROOM_SESSION_PREFIX)) return undefined
  const roomId = id.slice(ROOM_SESSION_PREFIX.length)
  return roomId.length > 0 ? roomId : undefined
}
