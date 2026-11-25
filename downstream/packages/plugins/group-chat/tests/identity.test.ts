import { describe, expect, it } from 'vitest'
import { DEFAULT_CREDENTIAL_REF, MANAGED_ENV, ROOM_SHARED_LINK, resolveRoomDirectory, resolveServerTarget, resolveWorkspaceRoot } from '../src/identity.ts'

const managedEnv = (overrides: Record<string, string | undefined> = {}) => ({
  [MANAGED_ENV.baseUrl]: 'http://host.docker.internal:3101',
  ...overrides,
})

describe('resolveServerTarget', () => {
  it('resolves a managed workspace from the environment alone', () => {
    expect(resolveServerTarget({ env: managedEnv() })?.baseUrl).toBe('http://host.docker.internal:3101')
  })

  it('defaults to the DataOps access token the workspace already holds', () => {
    // This reference is the one the credential store carries in a managed workspace;
    // the companion container deliberately has no credential in its environment.
    expect(resolveServerTarget({ env: managedEnv() })?.credentialRef).toBe('DATAOPS_ACCESS_TOKEN')
    expect(DEFAULT_CREDENTIAL_REF).toBe('DATAOPS_ACCESS_TOKEN')
  })

  it('gives the settings panel precedence over the environment', () => {
    const target = resolveServerTarget({
      baseUrl: 'https://rooms.example.com',
      credentialRef: 'MY_ROOM_TOKEN',
      env: managedEnv(),
    })
    expect(target?.baseUrl).toBe('https://rooms.example.com')
    expect(target?.credentialRef).toBe('MY_ROOM_TOKEN')
  })

  it('activates from a setting alone, with no DataOps environment at all', () => {
    const target = resolveServerTarget({ baseUrl: 'https://rooms.example.com', env: {} })
    expect(target?.baseUrl).toBe('https://rooms.example.com')
    expect(target?.credentialRef).toBe(DEFAULT_CREDENTIAL_REF)
  })

  it('stays inactive with nothing configured anywhere', () => {
    expect(resolveServerTarget({ env: {} })).toBeUndefined()
  })

  it('stays inactive when the URL is blank or whitespace', () => {
    expect(resolveServerTarget({ baseUrl: '', env: {} })).toBeUndefined()
    expect(resolveServerTarget({ baseUrl: '   ', env: {} })).toBeUndefined()
    expect(resolveServerTarget({ env: managedEnv({ [MANAGED_ENV.baseUrl]: '  ' }) })).toBeUndefined()
  })

  it('rejects a non-HTTP base URL instead of guessing', () => {
    expect(resolveServerTarget({ baseUrl: 'file:///tmp/x', env: {} })).toBeUndefined()
    expect(resolveServerTarget({ baseUrl: 'not-a-url', env: {} })).toBeUndefined()
    expect(resolveServerTarget({ baseUrl: 'ws://rooms.example.com', env: {} })).toBeUndefined()
  })

  it('accepts https, which a non-DataOps server may require', () => {
    expect(resolveServerTarget({ baseUrl: 'https://rooms.example.com', env: {} })?.baseUrl)
      .toBe('https://rooms.example.com')
  })

  it('strips trailing slashes so request paths never double up', () => {
    expect(resolveServerTarget({ baseUrl: 'https://rooms.example.com/base/', env: {} })?.baseUrl)
      .toBe('https://rooms.example.com/base')
  })

  it('trims surrounding whitespace rather than forwarding it', () => {
    expect(resolveServerTarget({ baseUrl: ' https://rooms.example.com ', env: {} })?.baseUrl)
      .toBe('https://rooms.example.com')
  })

  it('carries no actor: a bearer credential identifies the account server-side', () => {
    // A configured actor could disagree with the credential and silently change which
    // messages trigger this agent, so the target deliberately has no such field.
    expect(Object.keys(resolveServerTarget({ env: managedEnv() }) ?? {}).sort())
      .toEqual(['baseUrl', 'credentialRef'])
  })
})

describe('resolveWorkspaceRoot', () => {
  it('uses the mounted workspace root when DataOps provides one', () => {
    expect(resolveWorkspaceRoot({ [MANAGED_ENV.mountPath]: '/workspace' })).toBe('/workspace')
  })

  it('falls back to the process directory, so a room session still has a cwd', () => {
    expect(resolveWorkspaceRoot({})).toBe(process.cwd())
    expect(resolveWorkspaceRoot({ [MANAGED_ENV.mountPath]: '  ' })).toBe(process.cwd())
  })
})

describe('resolveRoomDirectory', () => {
  it('每个房间有自己的目录，不与别的房间共用一个 cwd', () => {
    // 共用 cwd 会让两个房间的会话撞在一起：房间打开了、消息也写进了 journal，
    // 但 agent 的 turn 永远不跑（实测：cwd 都回退到 /workspace 之后，
    // agentTrigger=always 的房间也收不到任何回复）。
    const first = resolveRoomDirectory('room-1', null, {
      [MANAGED_ENV.mountPath]: '/workspace',
      [MANAGED_ENV.sharedRoot]: '/group-chat-data',
      [MANAGED_ENV.home]: '/workspace/.dataops/dsh',
    })
    const second = resolveRoomDirectory('room-2', null, {
      [MANAGED_ENV.mountPath]: '/workspace',
      [MANAGED_ENV.sharedRoot]: '/group-chat-data',
      [MANAGED_ENV.home]: '/workspace/.dataops/dsh',
    })
    expect(first).not.toBe(second)
    expect(first).toBe('/workspace/.dataops/dsh/group-chat/rooms/room-1')
  })

  it('房间目录不在共享目录里', () => {
    // 共享目录是「多一个地方可看」，不是「所有路径的度量原点」。
    // 指到共享目录会让 kb/x.md 这类已有路径解析失败（实测 ENOENT）。
    const directory = resolveRoomDirectory('room-1', null, {
      [MANAGED_ENV.mountPath]: '/workspace',
      [MANAGED_ENV.sharedRoot]: '/group-chat-data',
      [MANAGED_ENV.home]: '/workspace/.dataops/dsh',
    })
    expect(directory).not.toContain('group-chat-data')
    expect(directory.startsWith('/workspace/')).toBe(true)
  })

  it('没有工作区挂载时仍然给每个房间一个独立目录', () => {
    // 缺 mountPath 不等于要把房间放进共享盘：共享盘的目录是「大家都能看的文件」，
    // 房间自己的 cwd 是「agent 在这里干活的地方」，两者合一会让房间的临时产物混进
    // 共享树。
    expect(resolveRoomDirectory('room-1', null, {
      [MANAGED_ENV.sharedRoot]: '/group-chat-data',
      [MANAGED_ENV.home]: '/dsh-home',
    })).toBe('/dsh-home/group-chat/rooms/room-1')
  })

  it('两者都没有时回退到 DSH home 下的 per-room 目录', () => {
    expect(resolveRoomDirectory('room-1', null, {
      [MANAGED_ENV.home]: '/workspace/.dataops/dsh',
    })).toBe('/workspace/.dataops/dsh/group-chat/rooms/room-1')
  })

  it('创建者显式选的目录仍然优先', () => {
    expect(resolveRoomDirectory('room-1', '/srv/reports', {
      [MANAGED_ENV.mountPath]: '/workspace',
      [MANAGED_ENV.sharedRoot]: '/group-chat-data',
    })).toBe('/srv/reports')
  })

  it('共享目录的入口名固定，供相对路径引用', () => {
    // 容器在 workspace 根上建这个软链；模板与容器都要用它，所以值是契约。
    expect(ROOM_SHARED_LINK).toBe('group-shared')
  })
})
