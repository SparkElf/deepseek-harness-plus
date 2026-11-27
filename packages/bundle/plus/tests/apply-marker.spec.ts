import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertPrebuiltSource,
  sourcePatchsetDigest,
  writeBuildMarker,
  type SelectedPatch,
} from '../src/apply.ts'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

/** A checkout with one commit and the two entry points a skip-build run requires. */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plus-build-marker-'))
  fixtures.push(root)
  git(root, ['init', '--quiet'])
  writeFileSync(join(root, 'README.md'), 'fixture\n')
  mkdirSync(join(root, 'apps/cli/lib'), { recursive: true })
  writeFileSync(join(root, 'apps/cli/lib/bin.js'), 'export {}\n')
  mkdirSync(join(root, 'packages/client/ui-chat/lib'), { recursive: true })
  writeFileSync(join(root, 'packages/client/ui-chat/lib/client.js'), 'export {}\n')
  git(root, ['add', '.'])
  git(root, [
    '-c', 'user.name=Plus Test',
    '-c', 'user.email=plus@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ])
  return root
}

function sourcePatch(root: string, id: string, contents: string): SelectedPatch {
  const file = `patches/${id}.patch`
  mkdirSync(join(root, 'patches'), { recursive: true })
  writeFileSync(join(root, file), contents)
  return {
    id,
    patchPackage: { name: '@sparkelf/dsh-plus', version: '0.0.0' },
    file,
    absoluteFile: join(root, file),
    target: { kind: 'dsh-source', baseRevision: 'base' },
    alreadyApplied: true,
  }
}

describe('Plus build marker', () => {
  it('digests the same patch set regardless of selection order', () => {
    const root = checkout()
    const first = sourcePatch(root, 'alpha', 'alpha\n')
    const second = sourcePatch(root, 'beta', 'beta\n')
    expect(sourcePatchsetDigest([first, second])).toBe(sourcePatchsetDigest([second, first]))
  })

  it('changes the digest when a patch payload changes', () => {
    const root = checkout()
    const patch = sourcePatch(root, 'alpha', 'alpha\n')
    const before = sourcePatchsetDigest([patch])
    writeFileSync(join(root, 'patches/alpha.patch'), 'alpha changed\n')
    expect(sourcePatchsetDigest([patch])).not.toBe(before)
  })

  it('accepts a marker written for the same revision and patch set', () => {
    const root = checkout()
    const revision = git(root, ['rev-parse', 'HEAD'])
    const patches = [sourcePatch(root, 'alpha', 'alpha\n')]
    writeBuildMarker(root, revision, patches)
    expect(() => { assertPrebuiltSource(root, patches, []) }).not.toThrow()
  })

  it('accepts a marker after the final phase pruned .git', () => {
    const root = checkout()
    const revision = git(root, ['rev-parse', 'HEAD'])
    const patches = [sourcePatch(root, 'alpha', 'alpha\n')]
    writeBuildMarker(root, revision, patches)
    rmSync(join(root, '.git'), { recursive: true, force: true })
    expect(() => { assertPrebuiltSource(root, patches, [], revision) }).not.toThrow()
  })

  it('refuses a pruned checkout whose marker names another revision', () => {
    const root = checkout()
    const revision = git(root, ['rev-parse', 'HEAD'])
    const patches = [sourcePatch(root, 'alpha', 'alpha\n')]
    writeBuildMarker(root, revision, patches)
    rmSync(join(root, '.git'), { recursive: true, force: true })
    expect(() => { assertPrebuiltSource(root, patches, [], 'f'.repeat(40)) })
      .toThrow('marker revision')
  })

  it('refuses a pruned checkout without a marker', () => {
    const root = checkout()
    const patches = [sourcePatch(root, 'alpha', 'alpha\n')]
    rmSync(join(root, '.git'), { recursive: true, force: true })
    expect(() => { assertPrebuiltSource(root, patches, [], 'f'.repeat(40)) })
      .toThrow('needs ' + join(root, '.dataops-official-build.json'))
  })

  it('refuses a checkout without a marker', () => {
    const root = checkout()
    const patches = [sourcePatch(root, 'alpha', 'alpha\n')]
    expect(() => { assertPrebuiltSource(root, patches, []) })
      .toThrow('needs ' + join(root, '.dataops-official-build.json'))
  })

  it('refuses a patch set that no longer matches the marker', () => {
    const root = checkout()
    const revision = git(root, ['rev-parse', 'HEAD'])
    const patches = [sourcePatch(root, 'alpha', 'alpha\n')]
    writeBuildMarker(root, revision, patches)
    writeFileSync(join(root, 'patches/alpha.patch'), 'alpha changed\n')
    expect(() => { assertPrebuiltSource(root, patches, []) }).toThrow('patch set differs')
  })

  it('refuses a checkout revision that no longer matches the marker', () => {
    const root = checkout()
    const revision = git(root, ['rev-parse', 'HEAD'])
    const patches = [sourcePatch(root, 'alpha', 'alpha\n')]
    writeBuildMarker(root, revision, patches)
    writeFileSync(join(root, 'README.md'), 'second commit\n')
    git(root, ['add', '.'])
    git(root, [
      '-c', 'user.name=Plus Test',
      '-c', 'user.email=plus@example.invalid',
      'commit', '--quiet', '-m', 'second',
    ])
    expect(() => { assertPrebuiltSource(root, patches, []) }).toThrow('marker revision')
  })

  it('refuses a pending source patch before reading the marker', () => {
    const root = checkout()
    const patch = sourcePatch(root, 'alpha', 'alpha\n')
    expect(() => { assertPrebuiltSource(root, [patch], [patch.absoluteFile]) }).toThrow('still pending')
  })

  it('refuses a marker whose built entry point is missing', () => {
    const root = checkout()
    const revision = git(root, ['rev-parse', 'HEAD'])
    const patches = [sourcePatch(root, 'alpha', 'alpha\n')]
    writeBuildMarker(root, revision, patches)
    rmSync(join(root, 'apps/cli/lib/bin.js'))
    expect(() => { assertPrebuiltSource(root, patches, []) }).toThrow('entry points are missing')
  })
})
