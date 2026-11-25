import { describe, expect, it, vi } from 'vitest'
import { ensureRoomWorkspace } from '../src/room-workspace.ts'

const PATH = '/workspace/.dataops/dsh/group-chat/rooms/room-1'
const TITLE = '群聊·研判组'
const SESSION = 'group-room-room-1'

/** A registry with one workspace, or none until `create` runs. */
const registryWith = (existing: boolean) => {
  const attachSession = vi.fn(async () => {})
  const workspace = { id: 'ws-1', attachSession }
  const create = vi.fn(async (path: string, title?: string) => {
    expect(path).toBe(PATH)
    expect(title).toBe(TITLE)
    return workspace
  })
  const resolveByPath = vi.fn(async (path: string) => {
    expect(path).toBe(PATH)
    return existing ? workspace : undefined
  })
  return { registry: { resolveByPath, create }, attachSession, create, resolveByPath }
}

describe('the workspace a room belongs to', () => {
  it('creates the workspace at the room directory and attaches the session', async () => {
    const { registry, attachSession, create } = registryWith(false)

    const outcome = await ensureRoomWorkspace(registry, PATH, TITLE, SESSION)

    // The path is the Session's own cwd: `attachSession` rejects anything else, which is why a
    // shared root would not work.
    expect(create).toHaveBeenCalledOnce()
    expect(attachSession).toHaveBeenCalledWith(SESSION)
    expect(outcome).toEqual({ workspaceId: 'ws-1', created: true })
  })

  it('reuses the workspace on a later open instead of creating a second one', async () => {
    const { registry, create, attachSession } = registryWith(true)

    const outcome = await ensureRoomWorkspace(registry, PATH, TITLE, SESSION)

    expect(create).not.toHaveBeenCalled()
    expect(attachSession).toHaveBeenCalledWith(SESSION)
    expect(outcome).toEqual({ workspaceId: 'ws-1', created: false })
  })

  it('answers without a workspace on a host that has no registry', async () => {
    // A minimal host mounts no workspace registry; the room still opens its events, only the
    // main view cannot follow.
    await expect(ensureRoomWorkspace(undefined, PATH, TITLE, SESSION)).resolves.toEqual({
      workspaceId: undefined,
      created: false,
    })
  })

  it('propagates a refused attach so the caller reports it', async () => {
    const registry = {
      resolveByPath: async () => ({ id: 'ws-1', attachSession: async () => { throw new Error('cwd mismatch') } }),
      create: async () => ({ id: 'ws-1', attachSession: async () => {} }),
    }

    await expect(ensureRoomWorkspace(registry, PATH, TITLE, SESSION)).rejects.toThrow('cwd mismatch')
  })
})