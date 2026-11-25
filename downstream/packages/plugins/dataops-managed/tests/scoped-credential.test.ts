import { describe, expect, it, vi } from 'vitest'
import { mintScopedCredential, scopedCredentialRef } from '../src/scoped-credential.ts'

const deps = (status: number, body: unknown, fail = false) => {
  const set = vi.fn(async () => {})
  const warn = vi.fn()
  const request = vi.fn(async () => {
    if (fail) throw new Error('network down')
    return { status, body }
  })
  return { request, set, warn }
}

describe('a room scoped credential', () => {
  it('folds the Session id the same way the MCP bridge does', () => {
    expect(scopedCredentialRef('DATAOPS_ACCESS_TOKEN', 'group-room-b1b6ed22-740f'))
      .toBe('DATAOPS_ACCESS_TOKEN_S_GROUP_ROOM_B1B6ED22_740F')
  })

  it('stores the minted token under the scoped ref', async () => {
    const d = deps(200, { token: 'tok-1' })
    const ref = await mintScopedCredential(d, 'DATAOPS_ACCESS_TOKEN', 'group-room-x', 'u-1')
    expect(ref).toBe('DATAOPS_ACCESS_TOKEN_S_GROUP_ROOM_X')
    expect(d.set).toHaveBeenCalledWith('DATAOPS_ACCESS_TOKEN_S_GROUP_ROOM_X', 'tok-1')
    expect(d.request).toHaveBeenCalledWith('/api/ai/workspace/scoped-token', expect.objectContaining({ method: 'POST' }))
  })

  it('warns and continues when the mint is refused or unreachable', async () => {
    for (const d of [deps(503, { error: 'no' }), deps(200, {}, false), deps(200, {}, true)]) {
      await expect(mintScopedCredential(d, 'DATAOPS_ACCESS_TOKEN', 'group-room-y', 'u-1')).resolves.toBeUndefined()
      expect(d.set).not.toHaveBeenCalled()
      expect(d.warn).toHaveBeenCalled()
    }
  })
})
