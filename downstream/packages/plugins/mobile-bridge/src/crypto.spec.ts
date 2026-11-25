import { describe, expect, it } from 'vitest'
import { decryptJSON, deriveKey, encryptJSON } from './crypto.ts'

describe('bridge crypto', () => {
  it('round-trips payloads between independently derived keys', async () => {
    const a = await deriveKey('pass', 'pair')
    const b = await deriveKey('pass', 'pair')
    const blob = await encryptJSON(a, { secret: 'stock web html' })
    await expect(decryptJSON(b, blob)).resolves.toEqual({ secret: 'stock web html' })
  })

  it('separates keys across passphrases and pairing secrets', async () => {
    const a = await deriveKey('pass', 'pair')
    const other = await deriveKey('other', 'pair')
    const blob = await encryptJSON(a, { x: 1 })
    await expect(decryptJSON(other, blob)).rejects.toThrow()
  })

  it('detects tampering', async () => {
    const a = await deriveKey('pass', 'pair')
    const blob = await encryptJSON(a, { x: 1 })
    const flipped = blob.slice(0, blob.length - 2) + (blob.endsWith('A') ? 'B' : 'A') + (blob.endsWith('A') ? 'A' : 'B')
    await expect(decryptJSON(a, flipped)).rejects.toThrow()
  })
})
