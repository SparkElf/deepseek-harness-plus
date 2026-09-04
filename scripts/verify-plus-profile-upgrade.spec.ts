import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fingerprintPackage, inspectProfile, profileDiff, verifyProfileUpgrade,
  type PlusProfileUpgradePolicy,
} from './verify-plus-profile-upgrade.ts'

const fixtures: string[] = []
afterEach(() => { for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true }) })

function profile(name: string, packages: Record<string, Record<string, string>>, bundles = ['@sparkelf/dsh-plus']): string {
  const root = mkdtempSync(join(tmpdir(), name))
  fixtures.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }))
  for (const [packageName, files] of Object.entries(packages)) {
    const directory = join(root, 'node_modules', ...packageName.split('/'))
    mkdirSync(join(directory, 'lib'), { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.0' }))
    for (const [path, payload] of Object.entries(files)) {
      const target = join(directory, path)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, payload)
    }
  }
  return root
}

function policy(baseline: string, candidate: string, mode: 'preserve' | 'replace', marker = 'kept'): PlusProfileUpgradePolicy {
  const before = inspectProfile(baseline).packages['@fixture/ui']!
  const after = inspectProfile(candidate).packages['@fixture/ui']!
  return {
    formatVersion: 1,
    name: 'fixture production closure',
    requiredBundles: ['@sparkelf/dsh-plus'],
    packages: {
      '@fixture/ui': {
        mode,
        version: '1.0.0',
        baselineSha256: before.fingerprint,
        candidateSha256: after.fingerprint,
        probes: [{ file: 'lib/client.js', contains: [marker] }],
      },
    },
  }
}

describe('Plus production profile closure gate', () => {
  it('accepts a byte-identical preserved runtime package', () => {
    const baseline = profile('plus-baseline-', { '@fixture/ui': { 'lib/client.js': 'kept' } })
    const candidate = profile('plus-candidate-', { '@fixture/ui': { 'lib/client.js': 'kept' } })
    expect(verifyProfileUpgrade(inspectProfile(baseline), inspectProfile(candidate), policy(baseline, candidate, 'preserve')))
      .toMatchObject({ changed: [], verified: ['@fixture/ui'] })
  })

  it('accepts only the exact declared replacement and its capability marker', () => {
    const baseline = profile('plus-baseline-', { '@fixture/ui': { 'lib/client.js': 'old' } })
    const candidate = profile('plus-candidate-', { '@fixture/ui': { 'lib/client.js': 'kept replacement' } })
    expect(verifyProfileUpgrade(inspectProfile(baseline), inspectProfile(candidate), policy(baseline, candidate, 'replace')).changed)
      .toEqual(['@fixture/ui'])
  })

  it('rejects same-version payload drift that has no policy entry', () => {
    const baseline = profile('plus-baseline-', { '@fixture/ui': { 'lib/client.js': 'old' }, '@fixture/hidden': { 'lib/client.js': 'one' } })
    const candidate = profile('plus-candidate-', { '@fixture/ui': { 'lib/client.js': 'kept replacement' }, '@fixture/hidden': { 'lib/client.js': 'two' } })
    expect(() => verifyProfileUpgrade(inspectProfile(baseline), inspectProfile(candidate), policy(baseline, candidate, 'replace')))
      .toThrow('@fixture/hidden: runtime payload changed without a policy entry')
  })

  it('rejects a preserve entry whose candidate bytes changed', () => {
    const baseline = profile('plus-baseline-', { '@fixture/ui': { 'lib/client.js': 'old' } })
    const candidate = profile('plus-candidate-', { '@fixture/ui': { 'lib/client.js': 'kept replacement' } })
    expect(() => verifyProfileUpgrade(inspectProfile(baseline), inspectProfile(candidate), policy(baseline, candidate, 'preserve')))
      .toThrow('preserve policy forbids runtime payload changes')
  })

  it('rejects missing capabilities and profile bundles', () => {
    const baseline = profile('plus-baseline-', { '@fixture/ui': { 'lib/client.js': 'old' } })
    const candidate = profile('plus-candidate-', { '@fixture/ui': { 'lib/client.js': 'replacement' } }, [])
    expect(() => verifyProfileUpgrade(inspectProfile(baseline), inspectProfile(candidate), policy(baseline, candidate, 'replace')))
      .toThrow(/missing required bundle[\s\S]*missing capability marker/u)
  })

  it('fingerprints runtime files but ignores source maps', () => {
    const root = profile('plus-profile-', { '@fixture/ui': { 'lib/client.js': 'one', 'lib/client.js.map': 'first' } })
    const directory = inspectProfile(root).packages['@fixture/ui']!.directory
    const before = fingerprintPackage(directory)
    writeFileSync(join(directory, 'lib/client.js.map'), 'second')
    expect(fingerprintPackage(directory)).toBe(before)
    writeFileSync(join(directory, 'lib/client.js'), 'two')
    expect(fingerprintPackage(directory)).not.toBe(before)
    expect(profileDiff(inspectProfile(root), inspectProfile(root))).toEqual([])
  })
})
