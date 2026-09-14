import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyProfileNpmPatches } from '../src/standalone-profile.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One throwaway directory removed after the test. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plus-patch-'))
  roots.push(root)
  return root
}

/**
 * Build a distribution carrying one npm patch and the package it patches.
 *
 * The patch changes a marker line, which is what the assertions read: the point is
 * that a start applies the bytes, not that a particular file changed.
 * @returns the distribution and profile directories.
 */
function installation(): { distribution: string; profile: string; patched: string } {
  const root = scratch()
  const distribution = join(root, 'distribution')
  const profile = join(root, 'profile')
  const patchPackage = join(distribution, 'node_modules', '@sparkelf', 'dsh-patch-demo')
  const target = join(profile, 'node_modules', 'demo-target')

  mkdirSync(join(patchPackage, 'patches'), { recursive: true })
  mkdirSync(target, { recursive: true })
  writeFileSync(join(distribution, 'package.json'), JSON.stringify({
    name: '@sparkelf/dsh-plus',
    version: '1.0.0',
    dshPlus: { patchPackages: ['@sparkelf/dsh-patch-demo'] },
  }))
  writeFileSync(join(patchPackage, 'package.json'), JSON.stringify({
    name: '@sparkelf/dsh-patch-demo',
    version: '1.0.0',
    dshPatch: {
      formatVersion: 1,
      variants: [{
        id: 'demo',
        dsh: '>=0.1.0',
        target: { kind: 'npm', name: 'demo-target', range: '1.0.0' },
        file: './patches/demo.patch',
      }],
    },
  }))
  const file = join(target, 'index.js')
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'demo-target', version: '1.0.0' }))
  writeFileSync(file, 'const value = "original"\n')
  writeFileSync(join(patchPackage, 'patches', 'demo.patch'), [
    'diff --git a/index.js b/index.js',
    '--- a/index.js',
    '+++ b/index.js',
    '@@ -1 +1 @@',
    '-const value = "original"',
    '+const value = "patched"',
    '',
  ].join('\n'))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-plus',
    private: true,
    dependencies: { '@sparkelf/dsh-plus': '1.0.0' },
  }))
  return { distribution, profile, patched: file }
}

describe('applyProfileNpmPatches', () => {
  it('applies a declared npm patch to the installed package', () => {
    // A standalone installation runs no apply step, so this is the only owner the
    // npm half of the patch set has; without it a published patch never reaches the
    // copy the launcher loads.
    const { distribution, profile, patched } = installation()
    const applied = applyProfileNpmPatches(distribution, profile)
    expect(applied).toHaveLength(1)
    expect(readFileSync(patched, 'utf8')).toContain('patched')
  })

  it('leaves an already patched package alone', () => {
    // A start runs on every launch and a reinstall restores the published bytes, so
    // the second run must be a no-op rather than a failure.
    const { distribution, profile, patched } = installation()
    applyProfileNpmPatches(distribution, profile)
    expect(applyProfileNpmPatches(distribution, profile)).toHaveLength(0)
    expect(readFileSync(patched, 'utf8')).toContain('patched')
  })

  it('names an uninstalled target instead of failing silently', () => {
    const { distribution, profile } = installation()
    rmSync(join(profile, 'node_modules', 'demo-target'), { recursive: true, force: true })
    expect(() => applyProfileNpmPatches(distribution, profile))
      .toThrow(/demo-target is not installed under/u)
  })

  it('skips a source target, which needs an official checkout', () => {
    // The standalone installation has no DSH source tree, so a source variant is not
    // this function's work; treating it as npm work would fail every start.
    const { distribution, profile, patched } = installation()
    const manifestPath = join(distribution, 'node_modules', '@sparkelf', 'dsh-patch-demo', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dshPatch: { variants: { target: { kind: string } }[] } }
    manifest.dshPatch.variants[0]!.target.kind = 'dsh-source'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(applyProfileNpmPatches(distribution, profile)).toHaveLength(0)
    expect(readFileSync(patched, 'utf8')).toContain('original')
  })
})
