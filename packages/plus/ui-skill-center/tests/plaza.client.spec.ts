/**
 * Skill-plaza status mapping: a local skill with no record is `local`; the
 * record's reviewStatus drives pending/approved/rejected; the older bridge
 * (sharedByMe without reviewStatus) maps to approved, never fabricated
 * pending.
 */
import { describe, expect, it } from 'vitest'
import { canSubmit, shareOf } from '../src/client/plaza.ts'
import type { PlazaSkill } from '../src/client/plaza.ts'

const record = (over: Partial<PlazaSkill> = {}): PlazaSkill => ({ id: 7, name: 'alpha', ...over })

describe('shareOf', () => {
  it('renders a missing record as local', () => {
    expect(shareOf('alpha', new Map())).toEqual({ status: 'local', sharedByMe: false })
  })

  it('maps the three backend review states', () => {
    for (const status of ['pending', 'approved', 'rejected'] as const) {
      const share = shareOf('alpha', new Map([['alpha', record({ reviewStatus: status, sharedByMe: true })]]))
      expect(share.status, status).toBe(status)
      expect(share.sharedByMe).toBe(true)
      expect(share.record?.id).toBe(7)
    }
  })

  it('maps a legacy shared row without reviewStatus to approved', () => {
    expect(shareOf('alpha', new Map([['alpha', record({ sharedByMe: true })]]))).toMatchObject({
      status: 'approved', sharedByMe: true,
    })
  })

  it('keeps an unshared record local', () => {
    expect(shareOf('alpha', new Map([['alpha', record({ sharedByMe: false })]]))).toMatchObject({
      status: 'local', sharedByMe: false,
    })
  })
})

describe('canSubmit', () => {
  it('offers publish for local/rejected and withholds it for pending/approved', () => {
    expect(canSubmit('local')).toBe(true)
    expect(canSubmit('rejected')).toBe(true)
    expect(canSubmit('pending')).toBe(false)
    expect(canSubmit('approved')).toBe(false)
  })
})
