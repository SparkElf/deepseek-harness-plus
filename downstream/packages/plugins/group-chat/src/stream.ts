/**
 * The room event stream.
 *
 * The server pushes a settled event as soon as it commits it, and this keeps one socket
 * open per workspace rather than per room: a socket follows each joined room, and the
 * server drops it from a room it is not a member of. The polling loop stays as the
 * fallback — a socket can be down for reasons the plugin never learns about, and a room
 * that only arrives over a working socket is a room whose messages can vanish silently.
 *
 * Late delivery is safe because every event carries the server's own id and the tracker
 * de-duplicates on it, so an event that arrives both ways is appended once.
 *
 * @module @sparkelf/dsh-group-chat/stream
 */

import { io, type Socket } from 'socket.io-client'
import type { RoomEvent } from './backend.ts'

/** The namespace the gateway serves. */
export const STREAM_NAMESPACE = '/ai/chat/rooms/stream'
/** The HTTP path the namespace is mounted on. */
export const STREAM_PATH = '/ai-chat-rooms-stream-ws'

/** One settled event, as the server publishes it. */
export interface StreamEvent {
  readonly id: string
  readonly roomId: string
  readonly event: RoomEvent
}

export interface RoomStreamOptions {
  /** Base URL of the server, the same one the REST client uses. */
  readonly baseUrl: string
  /** Resolves the bearer credential; called per connection attempt. */
  readonly token: () => Promise<string>
  /** Receives every pushed event. */
  readonly onEvent: (event: StreamEvent) => void
  /** Reports transport trouble. The caller logs it and relies on polling. */
  readonly onError?: (error: unknown) => void
}

export interface RoomStream {
  /** Ask to receive one room's events. Idempotent. */
  follow: (roomId: string) => void
  close: () => void
}

/**
 * Open the room event stream.
 *
 * The socket reconnects on its own, so this does not retry. Rooms followed before the
 * connection is up are remembered and re-sent on every (re)connect, because the server
 * keeps membership per socket and a reconnect produces a new one.
 *
 * @param options - server address, credential accessor, and the event sink.
 * There is no `unfollow`: a room is followed for the life of the socket, and the server
 * drops a socket from a room it is no longer a member of. Nothing here calls one, and a
 * method the server has no handler for would silently do nothing.
 *
 * @returns the handle the caller keeps for the life of the plugin.
 */
export const openRoomStream = (options: RoomStreamOptions): RoomStream => {
  const followed = new Set<string>()
  let socket: Socket | undefined
  let closed = false

  const connect = async (): Promise<void> => {
    if (closed) return
    let token: string
    try {
      token = await options.token()
    } catch (error) {
      // A missing credential is the settings panel's business; the poll keeps working.
      options.onError?.(error)
      return
    }
    if (closed) return

    socket = io(`${options.baseUrl}${STREAM_NAMESPACE}`, {
      path: STREAM_PATH,
      transports: ['websocket'],
      auth: { token },
      reconnection: true,
    })
    socket.on('connect', () => {
      for (const roomId of followed) socket?.emit('follow', { roomId })
    })
    socket.on('event', (payload: StreamEvent) => {
      // The server only sends events for rooms this socket follows, but a malformed
      // frame must not reach the tracker and be recorded as a real event.
      if (typeof payload?.id !== 'string' || typeof payload.roomId !== 'string') return
      options.onEvent(payload)
    })
    socket.on('connect_error', (error) => options.onError?.(error))
  }

  void connect()

  return {
    follow: (roomId) => {
      if (followed.has(roomId)) return
      followed.add(roomId)
      socket?.emit('follow', { roomId })
    },
    close: () => {
      closed = true
      followed.clear()
      socket?.close()
      socket = undefined
    },
  }
}
