import { describe, expect, it } from 'vitest'
import { isSecretKey, maskToken, redact, scrub } from '../scripts/lib/redact.mjs'

describe('spotting a secret field', () => {
  it('matches the names the backend actually uses', () => {
    for (const key of ['password', 'accessToken', 'refreshToken', 'challengeToken', 'secret', 'authorization']) {
      expect(isSecretKey(key)).toBe(true)
    }
  })

  it('is case-insensitive', () => {
    expect(isSecretKey('Password')).toBe(true)
    expect(isSecretKey('ACCESSTOKEN')).toBe(true)
  })

  it('catches a future name that merely contains a secret word', () => {
    // Substring, not equality: `newPasswordConfirm` must be caught without a list edit.
    expect(isSecretKey('newPasswordConfirm')).toBe(true)
  })

  it('leaves ordinary fields alone', () => {
    for (const key of ['username', 'email', 'roleCodes', 'displayName']) {
      expect(isSecretKey(key)).toBe(false)
    }
  })
})

describe('redacting a value tree', () => {
  it('masks a top-level password', () => {
    expect(redact({ username: 'ops', password: 'S3cret!Pass' }))
      .toEqual({ username: 'ops', password: '***' })
  })

  it('masks a nested token', () => {
    expect(redact({ user: { name: 'a', accessToken: 'xyz' } }))
      .toEqual({ user: { name: 'a', accessToken: '***' } })
  })

  it('masks inside arrays', () => {
    expect(redact([{ password: 'a' }, { password: 'b' }]))
      .toEqual([{ password: '***' }, { password: '***' }])
  })

  it('keeps non-secret structure intact', () => {
    const input = { users: [{ username: 'u1', roles: ['管理员'] }] }
    expect(redact(input)).toEqual(input)
  })

  it('does not mutate the input', () => {
    const input = { password: 'S3cret!Pass' }
    redact(input)
    expect(input.password).toBe('S3cret!Pass')
  })

  it('passes primitives through', () => {
    expect(redact('plain')).toBe('plain')
    expect(redact(42)).toBe(42)
    expect(redact(null)).toBe(null)
  })

  it('stops at a depth limit rather than recursing forever', () => {
    let deep = { v: 1 }
    for (let i = 0; i < 20; i += 1) deep = { child: deep }
    expect(() => redact(deep)).not.toThrow()
  })
})

describe('masking an access token', () => {
  it('keeps a prefix and the length, which distinguishes tokens without revealing one', () => {
    const masked = maskToken('abcdefghijklmnop')
    expect(masked).toContain('abcdefgh')
    expect(masked).toContain('16')
    expect(masked).not.toContain('ijklmnop')
  })

  it('handles an absent token', () => {
    expect(maskToken('')).toBe('(none)')
    expect(maskToken(undefined)).toBe('(none)')
  })
})

describe('scrubbing a secret out of free text', () => {
  it('replaces a password echoed inside an error message', () => {
    // Field-name redaction cannot reach prose; literal replacement can.
    expect(scrub('invalid password S3cret!Pass for ops', ['S3cret!Pass']))
      .toBe('invalid password *** for ops')
  })

  it('replaces every occurrence', () => {
    expect(scrub('a x b x c', ['x'])).toBe('a *** b *** c')
  })

  it('ignores empty secrets so a blank password changes nothing', () => {
    expect(scrub('unchanged', ['', ''])).toBe('unchanged')
  })

  it('handles several secrets at once', () => {
    expect(scrub('p=S3cret t=abc.def', ['S3cret', 'abc.def'])).toBe('p=*** t=***')
  })

  it('coerces non-string input', () => {
    expect(scrub(12345, [])).toBe('12345')
  })
})
