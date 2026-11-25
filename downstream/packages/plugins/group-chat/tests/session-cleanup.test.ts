import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GroupChatBackend } from '../src/backend.ts'
import type { GroupChatContext } from '../src/context.ts'
import { handleRoomRequest } from '../src/index.ts'
import {
  cleanupRoomSessions,
  isRoomSubSession,
  roomProjectKey,
  roomSessionDirectory,
  type RoomSessionRecord,
} from '../src/session-maintenance.ts'
import { ROOM_SESSION_PREFIX, roomSessionId } from '../src/session-id.ts'

const ROOM_ID = 'room-revenue'
const DIRECTORY = '/group-chat-data/room-revenue'
const PRIMARY = roomSessionId(ROOM_ID)

interface Archive {
  readonly archived: string[]
}

const record = (id: string, cwd = DIRECTORY, extra: Partial<RoomSessionRecord['header']> = {}): RoomSessionRecord => ({
  header: { id, cwd, ...extra },
})

const persistenceOf = (root: string, records: readonly RoomSessionRecord[]): {
  readonly root: string
  list(): Promise<readonly RoomSessionRecord[]>
} => ({ root, list: async () => records })

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'group-chat-cleanup-'))
  directories.push(root)
  return root
}

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const makeSessionDir = async (root: string, id: string): Promise<string> => {
  const directory = roomSessionDirectory(root, DIRECTORY, id)
  await mkdir(directory, { recursive: true })
  return directory
}

describe('the room project key matches the JSONL backend layout', () => {
  it('turns the observed room cwd into the directory seen in production', () => {
    // The 16,004-directory incident lived in exactly this project directory.
    expect(roomProjectKey(DIRECTORY)).toBe('--group-chat-data-room-revenue--')
  })
})

describe('room sub-session selection', () => {
  it('accepts only minted Session ids in this room directory', () => {
    const minted = `session-${randomUUID()}`
    expect(isRoomSubSession(record(minted), DIRECTORY, PRIMARY)).toBe(true)
    expect(isRoomSubSession(record(PRIMARY), DIRECTORY, PRIMARY)).toBe(false)
    expect(isRoomSubSession(record(roomSessionId('other-room')), DIRECTORY, PRIMARY)).toBe(false)
    expect(isRoomSubSession(record('ordinary-session'), DIRECTORY, PRIMARY)).toBe(false)
    expect(isRoomSubSession(record(minted, '/workspace/other'), DIRECTORY, PRIMARY)).toBe(false)
    expect(isRoomSubSession(record(minted, DIRECTORY, { origin: 'subagent', parentSession: PRIMARY }), DIRECTORY, PRIMARY)).toBe(false)
    expect(isRoomSubSession(record(minted), DIRECTORY, PRIMARY, new Set([minted]))).toBe(false)
  })
})

describe('cleanup by room', () => {
  it('reports every minted duplicate without touching the canonical Session', async () => {
    const root = await makeRoot()
    const minted = Array.from({ length: 20 }, () => `session-${randomUUID()}`)
    const subagent = `session-${randomUUID()}`
    const otherRoom = roomSessionId('other-room')
    const otherDirectory = `session-${randomUUID()}`
    const records = [
      record(PRIMARY),
      record(otherRoom),
      record(subagent, DIRECTORY, { origin: 'subagent', parentSession: PRIMARY }),
      record(otherDirectory, '/workspace/elsewhere'),
      ...minted.map((id) => record(id)),
    ]
    const archive: Archive = { archived: [] }
    const result = await cleanupRoomSessions({
      roomId: ROOM_ID,
      directory: DIRECTORY,
      primarySessionId: PRIMARY,
      persistence: persistenceOf(root, records),
      archive: { archiveSession: async (id) => { archive.archived.push(id) } },
    })

    expect(result.mode).toBe('report')
    expect(result.scanned).toBe(24)
    expect([...result.candidates].sort()).toEqual([...minted].sort())
    expect(result.archived).toEqual([])
    expect(result.removed).toEqual([])
    expect(archive.archived).toEqual([])
  })

  it('archives duplicates without deleting their files', async () => {
    const root = await makeRoot()
    const minted = Array.from({ length: 20 }, () => `session-${randomUUID()}`)
    const paths = await Promise.all(minted.map((id) => makeSessionDir(root, id)))
    const archive: Archive = { archived: [] }
    const result = await cleanupRoomSessions({
      roomId: ROOM_ID,
      directory: DIRECTORY,
      primarySessionId: PRIMARY,
      persistence: persistenceOf(root, minted.map((id) => record(id))),
      archive: { archiveSession: async (id) => { archive.archived.push(id) } },
      dryRun: false,
    })

    expect(result.mode).toBe('archive')
    expect([...result.archived].sort()).toEqual([...minted].sort())
    expect(result.removed).toEqual([])
    expect(archive.archived.sort()).toEqual([...minted].sort())
    for (const path of paths) await expect(import('node:fs/promises').then((fs) => fs.stat(path))).resolves.toBeDefined()
  })

  it('purges only the minted duplicates in this room directory', async () => {
    const root = await makeRoot()
    const minted = Array.from({ length: 20 }, () => `session-${randomUUID()}`)
    const subagent = `session-${randomUUID()}`
    const otherRoom = roomSessionId('other-room')
    const otherDirectory = `session-${randomUUID()}`
    const mintedPaths = await Promise.all(minted.map((id) => makeSessionDir(root, id)))
    const primaryPath = await makeSessionDir(root, PRIMARY)
    const subagentPath = await makeSessionDir(root, subagent)
    const otherRoomPath = await makeSessionDir(root, otherRoom)
    await mkdir(roomSessionDirectory(root, '/workspace/elsewhere', otherDirectory), { recursive: true })
    const result = await cleanupRoomSessions({
      roomId: ROOM_ID,
      directory: DIRECTORY,
      primarySessionId: PRIMARY,
      persistence: persistenceOf(root, [
        record(PRIMARY),
        record(subagent, DIRECTORY, { origin: 'subagent', parentSession: PRIMARY }),
        record(otherRoom),
        record(otherDirectory, '/workspace/elsewhere'),
        ...minted.map((id) => record(id)),
      ]),
      dryRun: false,
      purge: true,
    })

    expect(result.mode).toBe('purge')
    expect([...result.removed].sort()).toEqual([...minted].sort())
    expect(result.errors).toEqual([])
    const { stat } = await import('node:fs/promises')
    for (const path of mintedPaths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const path of [primaryPath, subagentPath, otherRoomPath]) await expect(stat(path)).resolves.toBeDefined()
  })

  it('refuses to purge when the backend exposes no physical root', async () => {
    await expect(cleanupRoomSessions({
      roomId: ROOM_ID,
      directory: DIRECTORY,
      primarySessionId: PRIMARY,
      persistence: { list: async () => [] },
      dryRun: false,
      purge: true,
    })).rejects.toThrow(/no physical root/u)
  })

  it('keeps the canonical id namespace protected even for another room sharing the directory', () => {
    expect(isRoomSubSession(record(`${ROOM_SESSION_PREFIX}shared-room`), DIRECTORY, PRIMARY)).toBe(false)
  })
})

describe('the cleanup route', () => {
  it('purges a room batch through the same request shape the browser uses', async () => {
    const root = await makeRoot()
    const minted = Array.from({ length: 3 }, () => `session-${randomUUID()}`)
    const paths = await Promise.all(minted.map((id) => makeSessionDir(root, id)))
    const backend = {
      listRooms: async () => [{ id: ROOM_ID, cwd: DIRECTORY }],
    } as unknown as GroupChatBackend
    const ctx = {
      sessionPersistence: persistenceOf(root, [record(PRIMARY), ...minted.map((id) => record(id))]),
      workspaceRegistry: { archiveSession: async () => {} },
    } as unknown as GroupChatContext

    const result = await handleRoomRequest(
      `rooms/${ROOM_ID}/sessions/cleanup`,
      'POST',
      { dryRun: false, purge: true, confirm: ROOM_ID },
      new URL(`http://dsh.internal/dsh-group-chat/api/rooms/${ROOM_ID}/sessions/cleanup`),
      backend,
      new Map(),
      () => {},
      ctx,
    ) as { readonly mode: string; readonly removed: readonly string[] }

    expect(result.mode).toBe('purge')
    expect([...result.removed].sort()).toEqual([...minted].sort())
    const { stat } = await import('node:fs/promises')
    for (const path of paths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a purge without the room-id confirmation', async () => {
    await expect(handleRoomRequest(
      `rooms/${ROOM_ID}/sessions/cleanup`,
      'POST',
      { dryRun: false, purge: true },
      new URL(`http://dsh.internal/dsh-group-chat/api/rooms/${ROOM_ID}/sessions/cleanup`),
      { listRooms: async () => [{ id: ROOM_ID, cwd: DIRECTORY }] } as unknown as GroupChatBackend,
      new Map(),
      () => {},
      {
        sessionPersistence: persistenceOf('/tmp', []),
      } as unknown as GroupChatContext,
    )).rejects.toThrow(/confirm/u)
  })
})