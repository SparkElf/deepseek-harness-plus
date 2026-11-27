import { describe, expect, it, vi } from 'vitest'
import { WorkspaceLimits, WorkspaceLimitsRejection } from '../src/workspace-limits.ts'

/** A Context stub whose credential resolution returns the given token. */
const contextWith = (token: string | undefined) => ({
  credentials: {
    resolve: vi.fn(async () => (token === undefined ? undefined : { value: token })),
  },
}) as never

/** A Response-like object the fetch stub can return. */
const respond = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
}) as Response

const CONFIG = { baseUrl: 'http://dataops.test:3101', credentialRef: 'DATAOPS_ACCESS_TOKEN' }

describe('WorkspaceLimits.save', () => {
  it('carries the reason DataOps refused the value', async () => {
    const fetchMock = vi.fn(async () => respond(400, {
      message: '工作区文件读取上限必须在 1 字节到 524288000 字节之间。',
    }))
    vi.stubGlobal('fetch', fetchMock)
    const limits = new WorkspaceLimits(contextWith('jwt'), CONFIG)

    await expect(limits.save({ fileReadMaxBytes: 525_336_576, uploadMaxBytes: 134_217_728 }))
      .rejects.toThrow(WorkspaceLimitsRejection)
    await expect(limits.save({ fileReadMaxBytes: 525_336_576, uploadMaxBytes: 134_217_728 }))
      .rejects.toThrow('工作区文件读取上限必须在 1 字节到 524288000 字节之间。')
    vi.unstubAllGlobals()
  })

  it('takes the first message when DataOps answers with a list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(400, { message: ['第一条原因'] })))
    const limits = new WorkspaceLimits(contextWith('jwt'), CONFIG)

    await expect(limits.save({ fileReadMaxBytes: 1, uploadMaxBytes: 1 }))
      .rejects.toThrow('第一条原因')
    vi.unstubAllGlobals()
  })

  it('falls back to the status line when the refusal carries no message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(400, {})))
    const limits = new WorkspaceLimits(contextWith('jwt'), CONFIG)

    await expect(limits.save({ fileReadMaxBytes: 1, uploadMaxBytes: 1 }))
      .rejects.toThrow('Workspace limits write failed with HTTP 400')
    vi.unstubAllGlobals()
  })

  it('reports a match as no session rather than a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(401, {})))

    await expect(new WorkspaceLimits(contextWith('jwt'), CONFIG).save({ fileReadMaxBytes: 1, uploadMaxBytes: 1 }))
      .resolves.toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('reads the ceilings back after a write', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? respond(200, {})
        : respond(200, { settings: { workspaceSize: { fileReadMaxBytes: 1024, uploadMaxBytes: 2048 } } }))
    vi.stubGlobal('fetch', fetchMock)
    const limits = new WorkspaceLimits(contextWith('jwt'), CONFIG)

    await expect(limits.save({ fileReadMaxBytes: 1024, uploadMaxBytes: 2048 }))
      .resolves.toEqual({ limits: { fileReadMaxBytes: 1024, uploadMaxBytes: 2048 }, canWrite: true, readOnlyReason: null })
    vi.unstubAllGlobals()
  })
})

describe('WorkspaceLimits.status', () => {
  it('reports no session when the credential is absent', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(new WorkspaceLimits(contextWith(undefined), CONFIG).status()).resolves.toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('refuses a document without both ceilings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { settings: { workspaceSize: { fileReadMaxBytes: 1024 } } })))
    const limits = new WorkspaceLimits(contextWith('jwt'), CONFIG)

    await expect(limits.status()).rejects.toThrow('unrecognized document')
    vi.unstubAllGlobals()
  })
})
