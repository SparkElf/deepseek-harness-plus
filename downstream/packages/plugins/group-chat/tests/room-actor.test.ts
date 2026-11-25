/**
 * A room carries the connector's identity onto its Session.
 *
 * The base's disclosure patch reads `Session.actor` and decides what the room may see; the room
 * server stores the value opaquely. These cases pin the two halves this plugin owns: nothing is
 * attached when the room has no actor, and the whole object is copied when it has one -- on the
 * created Session and again on a resumed one.
 *
 * @module tests/room-actor.test
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Session } from '@deepseek-ai/dsh-session'
import { RoomSessions, roomSessionId } from '../src/index.ts'
import type { GroupChatContext } from '../src/context.ts'

type Event = { type: string }

class FakeController {
  readonly requests: Array<{ readonly sessionId: string; readonly cwd?: string; readonly actor?: unknown }> = []
  readonly persisted = new Map<string, { session: Session; events: Event[] }>()
  readonly registry = new Map<string, Session>()

  async resolveAgent(sessionId: string) {
    const entry = this.persisted.get(sessionId)
    if (entry === undefined) return { error: { code: 'session/not-found' } }
    this.registry.set(sessionId, entry.session)
    return { agent: { session: entry.session } }
  }

  async create(request: { readonly sessionId: string; readonly cwd?: string; readonly actor?: unknown }) {
    this.requests.push(request)
    const existing = this.persisted.get(request.sessionId)
    const sessionId = request.sessionId
    const events: Event[] = existing?.events ?? [{ type: 'config' }]
    const session = {
      id: sessionId,
      header: { id: sessionId, cwd: request.cwd },
      snapshotEvents: () => events,
    } as unknown as Session & { actor?: unknown }
    // The controller builds the Session; the plugin then attaches the actor, exactly as production
    // does when the room scope carries one.
    this.persisted.set(sessionId, { session, events })
    this.registry.set(sessionId, session)
    return { sessionId }
  }

  async selectModel(): Promise<unknown> { return undefined }
  async archiveSession(): Promise<void> {}
  async unarchiveSession(): Promise<void> {}
  async ensureSharedLink(): Promise<{ state: 'ok' }> { return { state: 'ok' } }
  async createSharedLink(): Promise<{ state: 'ok' }> { return { state: 'ok' } }
}

const makeContext = (controller: FakeController): GroupChatContext => ({
  sessions: {
    get: (id: string) => controller.registry.get(id),
    list: () => [...controller.registry.values()],
  },
  agents: { get: () => undefined, list: () => [] },
  sessionController: controller,
  workspaceRegistry: controller,
  credentials: { resolve: async () => undefined },
  webServer: { register: () => () => {} },
}) as unknown as GroupChatContext

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const roomDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'group-chat-actor-'))
  directories.push(directory)
  return join(directory, 'room-1')
}

const ACTOR = { userId: 'u-1', permissions: ['data:resource:manage'] }

describe('a room Session carries its connector actor', () => {
  it('attaches nothing when the room has no actor', async () => {
    const controller = new FakeController()
    const sessions = new RoomSessions(makeContext(controller))
    const directory = await roomDirectory()

    const session = await sessions.ensure('room-1', { name: 'Room one', cwd: directory })

    // The create request stays byte-identical to the pre-actor call: no key appears at all.
    expect(Object.keys(controller.requests[0] ?? {})).toEqual(expect.arrayContaining(['sessionId', 'cwd']))
    expect(controller.requests[0]).not.toHaveProperty('actor')
    expect((session as Session & { actor?: unknown }).actor).toBeUndefined()
    expect(session.id).toBe(roomSessionId('room-1'))
  })

  it('copies the whole actor onto the created Session', async () => {
    const controller = new FakeController()
    const sessions = new RoomSessions(makeContext(controller))
    const directory = await roomDirectory()

    const session = await sessions.ensure('room-1', { name: 'Room one', cwd: directory, actor: ACTOR })

    expect((session as Session & { actor?: unknown }).actor).toEqual(ACTOR)
  })

  it('replaces the actor on a resumed Session', async () => {
    const controller = new FakeController()
    const sessions = new RoomSessions(makeContext(controller))
    const directory = await roomDirectory()

    await sessions.ensure('room-1', { name: 'Room one', cwd: directory, actor: ACTOR })
    const refreshed = { userId: 'u-1', permissions: [] }
    const resumed = await sessions.ensure('room-1', { name: 'Room one', cwd: directory, actor: refreshed })

    // Same Session, replaced identity: the connector swaps the object rather than mutating it.
    expect(resumed.id).toBe(roomSessionId('room-1'))
    expect((resumed as Session & { actor?: unknown }).actor).toEqual(refreshed)
  })

  it('leaves a resumed Session untouched when the room no longer carries an actor', async () => {
    const controller = new FakeController()
    const sessions = new RoomSessions(makeContext(controller))
    const directory = await roomDirectory()

    await sessions.ensure('room-1', { name: 'Room one', cwd: directory, actor: ACTOR })
    const resumed = await sessions.ensure('room-1', { name: 'Room one', cwd: directory })

    // Absent means "the room server did not supply one", not "clear it": a room opened by an older
    // connector must not silently drop the identity it was created with.
    expect((resumed as Session & { actor?: unknown }).actor).toEqual(ACTOR)
    expect(randomUUID()).toHaveLength(36)
  })
})