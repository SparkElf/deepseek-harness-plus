import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import type { GroupChatContext } from '../src/context.ts'
import { RoomSessions, roomSessionId } from '../src/index.ts'

/**
 * The room/open contract this file pins is the one that failed in production:
 *
 * - `sessionController.create({ sessionId })` is not a create-or-reuse call. Once the
 *   named Session has a `turn/start`, the controller mints `session-<uuid>` in the same
 *   cwd instead of returning the named Session.
 * - The session registry is process-local, so an already persisted room Session is not
 *   visible to `sessions.get()` after a restart.
 *
 * The combination made every restart mint another throwaway Session; a three-second
 * discovery retry turned that into 16,004 directories. The room must instead resolve the
 * persisted Session before it ever considers `create`.
 */

type Event = { readonly type: string }

class FakeController {
  readonly persisted = new Map<string, { readonly session: Session; readonly events: Event[] }>()
  readonly registry = new Map<string, Session>()
  readonly createCalls: string[] = []
  readonly modelCalls: string[] = []
  readonly archived: string[] = []
  readonly unarchived: string[] = []

  sessionOf(sessionId: string): Session | undefined {
    return this.persisted.get(sessionId)?.session
  }

  async resolveAgent(sessionId: string): Promise<{ agent: { session: Session } } | { error: unknown }> {
    const entry = this.persisted.get(sessionId)
    if (entry === undefined) return { error: { code: 'session/not-found' } }
    this.registry.set(sessionId, entry.session)
    return { agent: { session: entry.session } }
  }

  async create(request: { readonly sessionId: string; readonly cwd?: string }): Promise<{ readonly sessionId: string }> {
    this.createCalls.push(request.sessionId)
    const existing = this.persisted.get(request.sessionId)
    // The shipped controller's exact rule: a named Session with a started turn is not
    // reusable, so the call mints a new identity under the same cwd.
    const sessionId = existing !== undefined && existing.events.some((event) => event.type === 'turn/start')
      ? `session-${randomUUID()}`
      : request.sessionId
    const events: Event[] = existing?.events ?? [{ type: 'config' }]
    const session = {
      id: sessionId,
      header: { id: sessionId, cwd: request.cwd },
      snapshotEvents: () => events,
    } as unknown as Session
    this.persisted.set(sessionId, { session, events })
    this.registry.set(sessionId, session)
    return { sessionId }
  }

  async selectModel(request: { readonly sessionId: string }): Promise<unknown> {
    this.modelCalls.push(request.sessionId)
    return undefined
  }

  async archiveSession(sessionId: string): Promise<void> {
    this.archived.push(sessionId)
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    this.unarchived.push(sessionId)
  }
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

const createWarmRoom = async (controller: FakeController): Promise<{ sessions: RoomSessions; directory: string }> => {
  const directory = await roomDirectory()
  const sessions = new RoomSessions(makeContext(controller))
  const room = await sessions.ensure('room-1', { name: 'Room one', cwd: directory })
  expect(room.id).toBe(roomSessionId('room-1'))
  // Every room runs a warm-up turn before a member can open its conversation.
  controller.persisted.get(room.id)?.events.push({ type: 'turn/start' })
  return { sessions, directory }
}

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const roomDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'group-chat-reuse-'))
  directories.push(directory)
  return join(directory, 'room-1')
}

describe('one room keeps one Session', () => {
  it('reuses the persisted room Session across 1000 restarts and keeps its history', async () => {
    const controller = new FakeController()
    const { sessions, directory } = await createWarmRoom(controller)
    const canonical = controller.persisted.get(roomSessionId('room-1'))
    expect(canonical).toBeDefined()
    expect(controller.createCalls).toEqual([roomSessionId('room-1')])

    for (let restart = 0; restart < 1000; restart += 1) {
      // A restart drops the process-local registry; persistence survives.
      controller.registry.clear()
      const room = await sessions.ensure('room-1', { name: 'Room one', cwd: directory })
      expect(room.id).toBe(roomSessionId('room-1'))
      expect(room.snapshotEvents().some((event) => event.type === 'turn/start')).toBe(true)
    }

    expect(controller.createCalls).toEqual([roomSessionId('room-1')])
    expect(controller.persisted.size).toBe(1)
    expect([...controller.persisted.keys()]).toEqual([roomSessionId('room-1')])
  })

  it('keeps the stored Session count at one across 1000 messages, so session/list cannot grow', async () => {
    const controller = new FakeController()
    const { sessions, directory } = await createWarmRoom(controller)
    for (let message = 0; message < 1000; message += 1) {
      const room = await sessions.ensure('room-1', { name: 'Room one', cwd: directory })
      expect(room.id).toBe(roomSessionId('room-1'))
    }
    expect(controller.createCalls).toHaveLength(1)
    expect(controller.persisted.size).toBe(1)
  })

  it('refuses a minted replacement and archives it instead of adopting it', async () => {
    const controller = new FakeController()
    const directory = await roomDirectory()
    // Seed a persisted canonical Session but make resolution deny it, so `create` is the
    // only path left and the controller mints. That is the failure mode this guard covers.
    const canonical = {
      id: roomSessionId('room-1'),
      header: { id: roomSessionId('room-1'), cwd: directory },
      snapshotEvents: () => [{ type: 'turn/start' }],
    } as unknown as Session
    controller.persisted.set(canonical.id, { session: canonical, events: [{ type: 'turn/start' }] })
    controller.resolveAgent = async () => ({ error: { code: 'session/not-found' } })
    const sessions = new RoomSessions(makeContext(controller))

    await expect(sessions.ensure('room-1', { name: 'Room one', cwd: directory })).rejects.toThrow(
      /controller opened session-/u,
    )
    expect(controller.archived).toHaveLength(1)
    expect(controller.archived[0]).toMatch(/^session-/u)
  })

  it('does not create when resolution fails for a reason other than not-found', async () => {
    const controller = new FakeController()
    controller.resolveAgent = async () => ({ error: { code: 'gateway/internal' } })
    const sessions = new RoomSessions(makeContext(controller))
    const directory = await roomDirectory()

    await expect(sessions.ensure('room-1', { name: 'Room one', cwd: directory })).rejects.toThrow(
      /could not resolve room session/u,
    )
    expect(controller.createCalls).toEqual([])
  })
})