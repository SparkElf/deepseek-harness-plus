import { describe, expect, it } from 'vitest'
import { bundledPinIssues, comparePin, driftExitCode, localPatchIssues, parseManifest } from './check-curated-plugins.mjs'

describe('curated plugin manifest', () => {
  it('parses entries and rejects malformed ones', () => {
    const entries = parseManifest('entries:\n  - name: a\n    source: { kind: npm, spec: x }\n    pinned: 1.0.0\n    localPatches: [{ file: patches/a.patch, upstreamUrl: https://github.com/o/x/pull/1, retireWhen: remove-after-1.1.0 }]\n')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.localPatches).toEqual([{
      file: 'patches/a.patch',
      upstreamUrl: 'https://github.com/o/x/pull/1',
      retireWhen: 'remove-after-1.1.0',
    }])
    expect(() => parseManifest('entries:\n  - name: a\n')).toThrow(/pinned/)
    expect(() => parseManifest('entries:\n  - name: a\n    source: { kind: npm, spec: x }\n    pinned: 1.0.0\n    localPatches: [{ file: patches/a.patch }]\n')).toThrow(/upstreamUrl/)
    expect(() => parseManifest('entries:\n  - name: a\n    source: { kind: npm, spec: x }\n    pinned: 1.0.0\n    localPatches: [{ file: patches/a.patch, upstreamUrl: https://github.com/o/x/issues/1, retireWhen: remove-after-1.1.0 }]\n')).toThrow(/pull request URL/)
    expect(() => parseManifest('entries: nope')).toThrow(/list/)
    expect(() => parseManifest('entries:\n  - name: a\n    source: { kind: npm }\n    pinned: 1.0.0\n    localPatches: []\n')).toThrow(/spec/)
    expect(() => parseManifest('entries:\n  - name: a\n    source: { kind: other, spec: x }\n    pinned: 1.0.0\n    localPatches: []\n')).toThrow(/npm or git/)
  })

  it('flags drift only when the pin differs from latest', () => {
    const entry = { name: 'a', source: { kind: 'npm', spec: 'x' }, pinned: '1.0.0', localPatches: [] }
    expect(comparePin(entry, '1.0.0').drifted).toBe(false)
    expect(comparePin(entry, '1.1.0').drifted).toBe(true)
  })

  it('requires default-mounted plugins at the curated dependency pin', () => {
    const entry = { name: 'a', source: { kind: 'npm', spec: 'x' }, pinned: '1.0.0', localPatches: [], plusBundle: true }
    expect(bundledPinIssues([entry], { x: '1.0.0' }, ['x'])).toEqual([])
    expect(bundledPinIssues([entry], { x: '1.1.0' }, ['x'])).toEqual([
      'a: curated pin 1.0.0 must equal packages/bundle/web-app dependency 1.1.0',
    ])
    expect(bundledPinIssues([entry], { x: '1.0.0' }, [])).toEqual([
      'a: npm source x is missing from PROFILE_TEMPLATES.web',
    ])
  })

  it('requires local patches under the curated npm pin', () => {
    const entry = parseManifest('entries:\n  - name: a\n    source: { kind: npm, spec: x }\n    pinned: 1.0.0\n    localPatches: [{ file: patches/a.patch, upstreamUrl: https://github.com/o/x/pull/1, retireWhen: remove-after-1.1.0 }]\n')[0]!
    expect(localPatchIssues([entry], { 'x@1.0.0': 'patches/a.patch' })).toEqual([])
    expect(localPatchIssues([entry], {})).toEqual([
      'a: x@1.0.0 must register patches/a.patch in pnpm-workspace.yaml',
    ])
  })

  it('fails incomplete lookups before reporting version drift', () => {
    expect(driftExitCode(0, 0, true)).toBe(0)
    expect(driftExitCode(1, 0, false)).toBe(0)
    expect(driftExitCode(1, 0, true)).toBe(2)
    expect(driftExitCode(1, 1, true)).toBe(1)
  })
})
