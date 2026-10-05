/**
 * Behavior the peer overrides promise: every version one names is one the registry published.
 *
 * The override pass pins a package the runtime family is expected to release with the runtime.
 * One official package can lag that family, and when it does the generated override names a
 * version no registry serves: npm then fails the whole install with ERESOLVE, and only once
 * something asks for that peer, so a profile that omitted peers carried the defect unnoticed.
 */

import { describe, expect, it } from 'vitest'
import { isPublishedVersion, resolvePeerOverrides } from './peer-overrides.ts'

describe('resolvePeerOverrides', () => {
  it('names only versions the registry published', () => {
    const overrides = resolvePeerOverrides(['@changfenhuang/dsh-genui@0.11.3'], '0.2.1-alpha.1')
    expect(overrides.length).toBeGreaterThan(0)
    for (const entry of overrides) {
      expect(isPublishedVersion(entry.name, entry.version)).toBe(true)
    }
  }, 120_000)

  it('pins an official package that published the runtime version to it', () => {
    const overrides = resolvePeerOverrides(['@changfenhuang/dsh-genui@0.11.3'], '0.2.1-alpha.1')
    const session = overrides.find(entry => entry.name === '@deepseek-ai/dsh-session')
    expect(session?.version).toBe('0.2.1-alpha.1')
  }, 120_000)

  it('falls back for an official package that did not publish it', () => {
    const overrides = resolvePeerOverrides(['@changfenhuang/dsh-genui@0.11.3'], '0.2.1-alpha.1')
    const invariants = overrides.find(entry => entry.name === '@deepseek-ai/dsh-invariants')
    expect(invariants?.version).not.toBe('0.2.1-alpha.1')
    expect(isPublishedVersion('@deepseek-ai/dsh-invariants', invariants?.version ?? '')).toBe(true)
  }, 120_000)
})
