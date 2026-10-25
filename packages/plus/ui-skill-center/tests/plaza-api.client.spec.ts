/**
 * Same-origin skill-plaza bridge client. A 503 is a distinct "not ready"
 * result (the card disables publishing); the submit body uses `action:
 * "submit"` and never sends a local path or level.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlazaUnavailableError, SkillApi } from '../src/client/api.ts'

const original = globalThis.fetch

afterEach(() => {
  globalThis.fetch = original
  vi.restoreAllMocks()
})

function answer(status: number, body: unknown): void {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

describe('SkillApi.plazaMine', () => {
  it('reads mine and drops rows that are neither shared nor reviewed', async () => {
    answer(200, { skills: [
      { id: 1, name: 'alpha', reviewStatus: 'approved', sharedByMe: true },
      { id: 2, name: 'beta', sharedByMe: false },
      { id: 3, name: 'gamma', reviewStatus: 'pending', sharedByMe: true },
    ] })
    const rows = await new SkillApi().plazaMine()
    expect(rows.map(row => row.name)).toEqual(['alpha', 'gamma'])
  })

  it('throws PlazaUnavailableError on 503', async () => {
    answer(503, { error: 'skill plaza is not active' })
    await expect(new SkillApi().plazaMine()).rejects.toBeInstanceOf(PlazaUnavailableError)
  })
})

describe('SkillApi.reviewContext', () => {
  it('reads the nested review permission block the bridge returns', async () => {
    answer(200, {
      departmentCode: 'data-platform',
      departmentPath: [{ code: 'data-platform', name: '数据平台' }],
      review: { canReview: true, canReviewGlobal: true },
    })
    const scope = await new SkillApi().reviewContext()
    expect(scope).toMatchObject({ canReview: true, canReviewGlobal: true, departmentCode: 'data-platform' })
  })
})

describe('SkillApi.plazaSubmit', () => {
  it('posts action=submit with name/description/instruction/tags only', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, skill: {
      id: 9, name: 'alpha', reviewStatus: 'pending', sharedByMe: true,
    } }), { status: 201, headers: { 'content-type': 'application/json' } }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const row = await new SkillApi().plazaSubmit({
      name: 'alpha', description: 'd', instruction: 'body', tags: ['data'],
    })
    expect(row).toMatchObject({ id: 9, name: 'alpha', reviewStatus: 'pending' })
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({
      action: 'submit', name: 'alpha', description: 'd', instruction: 'body', tags: ['data'],
    })
    expect(String(init.body)).not.toContain('/workspace')
    expect(String(init.body)).not.toContain('level')
  })

  it('passes visibility and departmentCode through to the bridge', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ skill: { id: 1, name: 'alpha', reviewStatus: 'pending' } }), { status: 201 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await new SkillApi().plazaSubmit({
      name: 'alpha', instruction: 'body', visibility: 'department', departmentCode: 'D1',
    })
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toMatchObject({
      action: 'submit', visibility: 'department', departmentCode: 'D1',
    })
  })

  it('falls back to the legacy share action on an older bridge', async () => {
    let call = 0
    globalThis.fetch = vi.fn(async () => {
      call += 1
      if (call === 1) return new Response(JSON.stringify({ error: 'unknown action' }), { status: 400 })
      return new Response(JSON.stringify({ skill: { id: 4, name: 'alpha' } }), { status: 200 })
    }) as unknown as typeof fetch
    const row = await new SkillApi().plazaSubmit({ name: 'alpha', instruction: 'body' })
    expect(row).toMatchObject({ id: 4, name: 'alpha', reviewStatus: 'pending' })
  })
})

describe('SkillApi.plazaUnshare', () => {
  it('posts action=unshare with the numeric id', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await new SkillApi().plazaUnshare(12)
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({ action: 'unshare', id: 12 })
  })
})
