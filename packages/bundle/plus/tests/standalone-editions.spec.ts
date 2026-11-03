import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureProfile, readDistributionProfile } from '../src/standalone-profile.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plus-edition-'))
  roots.push(root)
  return root
}

/**
 * A distribution with two editions over one patch set.
 *
 * The editions share the profile bundles and differ only in the packages they install;
 * that is the property the CLI relies on when it materializes a profile.
 */
function distribution(): string {
  const root = scratch()
  const directory = join(root, 'distribution')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: '@sparkelf/dsh-plus',
    version: '1.0.0',
    dshPlus: {
      compatibility: { dsh: '>=0.2.2-alpha.2' },
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@sparkelf/dsh-plus'],
        dependencies: { '@sparkelf/dsh-mineru': '0.1.4' },
        allowBuilds: {},
      },
      editions: {
        personal: {
          label: '个人版',
          bundles: ['@deepseek-ai/dsh-base', '@sparkelf/dsh-plus'],
          packages: { '@sparkelf/dsh-mineru': '0.1.4' },
        },
        team: {
          label: '团队版',
          bundles: ['@deepseek-ai/dsh-base', '@sparkelf/dsh-plus', '@sparkelf/dsh-dataops-managed'],
          packages: {
            '@sparkelf/dsh-mineru': '0.1.4',
            '@sparkelf/dsh-dataops-managed': '0.3.21',
          },
        },
      },
    },
  }))
  return directory
}

describe('editions', () => {
  it('reads both package manifests from the distribution', () => {
    const directory = distribution()
    const profile = readDistributionProfile(directory)
    expect(Object.keys(profile.editions)).toEqual(['personal', 'team'])
    expect(profile.editions.team?.label).toBe('团队版')
    expect(profile.editions.team?.packages['@sparkelf/dsh-dataops-managed']).toBe('0.3.21')
    expect(profile.editions.personal?.packages['@sparkelf/dsh-dataops-managed']).toBeUndefined()
    expect(profile.editions.team?.bundles).toContain('@sparkelf/dsh-dataops-managed')
  })

  it('names the offered editions when the requested one is unknown', () => {
    const directory = distribution()
    const root = scratch()
    const paths = {
      home: root,
      profileName: 'plus',
      profileDirectory: join(root, 'profiles', 'plus'),
      distributionDirectory: directory,
      omittedPackages: {},
    }
    expect(() => ensureProfile(paths, root, 'missing')).toThrow(/offers personal, team/u)
  })
})
