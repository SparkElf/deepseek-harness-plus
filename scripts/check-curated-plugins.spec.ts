import { describe, expect, it } from 'vitest'
import { comparePin, parseManifest } from './check-curated-plugins.mjs'

describe('curated plugin manifest', () => {
  it('parses entries and rejects malformed ones', () => {
    const entries = parseManifest('entries:\n  - name: a\n    source: { kind: npm, spec: x }\n    pinned: 1.0.0\n')
    expect(entries).toHaveLength(1)
    expect(() => parseManifest('entries:\n  - name: a\n')).toThrow(/pinned/)
    expect(() => parseManifest('entries: nope')).toThrow(/list/)
  })

  it('flags drift only when the pin differs from latest', () => {
    const entry = { name: 'a', source: { kind: 'npm', spec: 'x' }, pinned: '1.0.0' }
    expect(comparePin(entry, '1.0.0').drifted).toBe(false)
    expect(comparePin(entry, '1.1.0').drifted).toBe(true)
  })
})
