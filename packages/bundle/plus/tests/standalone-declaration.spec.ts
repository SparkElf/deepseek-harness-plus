import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readStandaloneDeclaration, resolvePaths } from '../src/standalone-profile.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Lay out an installation the way npm does: the variant package beside the distribution,
 * both under one `node_modules`, with the CLI reached through the variant's forwarder.
 *
 * The layout matters. A forwarder imports the CLI in-process, so `import.meta.url` names
 * `@sparkelf/dsh-plus` while the installed command is the variant next to it. An anchor
 * taken from this module therefore reaches no declaration and the variant silently
 * materializes the full profile, keeping every capability it exists to exclude.
 * @param variant - package name the variant declares, or null for the full package.
 * @returns the variant's `bin.js` path, which is the invoked entry.
 */
function installedVariant(variant: { name: string; profile: string } | null): string {
  const root = join(tmpdir(), 'dsh-plus-declaration-' + String(Math.random()).slice(2))
  roots.push(root)
  const scope = join(root, 'node_modules', '@sparkelf')
  mkdirSync(scope, { recursive: true })
  const command = join(scope, 'dsh-dataops-standalone')
  mkdirSync(join(command, 'lib'), { recursive: true })
  const bin = join(command, 'lib', 'bin.js')
  const manifest = variant === null
    ? { name: '@sparkelf/dsh-plus-standalone', version: '1.0.0' }
    : {
      name: '@sparkelf/dsh-dataops-standalone',
      version: '1.0.0',
      dshPlusStandalone: {
        profile: variant.profile,
        omittedPackages: {
          '@deepseek-ai/dsh-computer-use': 'npm:@sparkelf/dsh-omitted@1.0.0',
        },
      },
    }
  writeFileSync(join(command, 'package.json'), JSON.stringify(manifest))
  // The distribution the CLI resolves from the same tree position.
  const distribution = join(scope, 'dsh-plus')
  mkdirSync(distribution, { recursive: true })
  writeFileSync(join(distribution, 'package.json'), JSON.stringify({ name: '@sparkelf/dsh-plus', version: '1.0.0' }))
  writeFileSync(bin, '// the installed command')
  return bin
}

describe('standalone declaration lookup', () => {
  it('reads the profile and omissions the installed variant declares', () => {
    const bin = installedVariant({ name: '@sparkelf/dsh-dataops-standalone', profile: 'dataops-web' })
    const declaration = readStandaloneDeclaration(bin)
    expect(declaration.profileName).toBe('dataops-web')
    expect(Object.keys(declaration.omittedPackages)).toEqual(['@deepseek-ai/dsh-computer-use'])
  })

  it('falls back to the full profile when the installing package declares none', () => {
    const bin = installedVariant(null)
    const declaration = readStandaloneDeclaration(bin)
    expect(declaration.profileName).toBe('plus')
    expect(declaration.omittedPackages).toEqual({})
  })

  it('names the variant profile in the paths it resolves', () => {
    // The profile directory follows the declaration, so a lookup that fell back would
    // place the deployment beside the full profile rather than on top of it.
    const bin = installedVariant({ name: '@sparkelf/dsh-dataops-standalone', profile: 'dataops-web' })
    const paths = resolvePaths(bin, { DSH_HOME: join(tmpdir(), 'dsh-plus-home-' + String(Math.random()).slice(2)) })
    expect(paths.profileName).toBe('dataops-web')
    expect(paths.profileDirectory.endsWith(join('profiles', 'dataops-web'))).toBe(true)
  })
})
