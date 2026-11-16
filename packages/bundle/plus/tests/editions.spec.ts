import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureProfile, readDistributionProfile } from '../src/profile.ts'
import { PROFILE_COMPATIBILITY_FILENAME, writeProfileCompatibility } from '../src/manifest.ts'

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
      runtime: { version: '0.2.2-alpha.2' },
      omission: { package: '@sparkelf/dsh-omitted', version: '0.2.1-alpha.48' },
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@sparkelf/dsh-plus'],
        compatibility: ['@sparkelf/dsh-mineru@0.1.4'],
        dependencies: {
          '@sparkelf/dsh-mineru': '0.1.4',
          '@sparkelf/dsh-dataops-managed': '0.3.33',
        },
        allowBuilds: {},
      },
      patchSet: {
        formatVersion: 1,
        entries: [
          { id: 'base', dsh: '>=0.2.2-alpha.2', file: './patches/base.patch', retireWhen: 'never', target: { kind: 'dsh-source', packages: ['@deepseek-ai/dsh-base'], paths: ['packages/bundle/base/'] } },
        ],
      },
      editions: {
        personal: {
          label: '个人版',
          profile: 'plus',
          bundles: ['@deepseek-ai/dsh-base', '@sparkelf/dsh-plus'],
          packages: ['@sparkelf/dsh-mineru'],
          omit: [],
        },
        team: {
          label: '团队版',
          profile: 'plus',
          bundles: ['@deepseek-ai/dsh-base', '@sparkelf/dsh-plus', '@sparkelf/dsh-dataops-managed'],
          packages: ['@sparkelf/dsh-mineru', '@sparkelf/dsh-dataops-managed'],
          omit: [],
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
    expect(profile.editions.team?.packages).toContain('@sparkelf/dsh-dataops-managed')
    expect(profile.editions.personal?.packages).not.toContain('@sparkelf/dsh-dataops-managed')
    expect(profile.editions.team?.bundles).toContain('@sparkelf/dsh-dataops-managed')
  })

  it('reads the declared compatibility grants', () => {
    const directory = distribution()
    expect(readDistributionProfile(directory).compatibilityExemptions).toEqual(['@sparkelf/dsh-mineru@0.1.4'])
  })

  it('writes the profile compatibility file without dropping an existing grant', () => {
    // The file is the app-boot preflight's grant mechanism and also holds grants a user or
    // image wrote for other plugins; a materialization must merge, not replace.
    const profile = join(scratch(), 'profile')
    writeProfileCompatibility(profile, ['@sparkelf/dsh-mineru@0.1.4'], '0.2.2-rc.2')
    expect(JSON.parse(readFileSync(join(profile, PROFILE_COMPATIBILITY_FILENAME), 'utf8'))).toEqual({
      '@sparkelf/dsh-mineru@0.1.4': ['0.2.2-rc.2'],
    })
    writeProfileCompatibility(profile, ['@sparkelf/dsh-mineru@0.1.4'], '0.2.3-rc.1')
    const merged = JSON.parse(readFileSync(join(profile, PROFILE_COMPATIBILITY_FILENAME), 'utf8')) as Record<string, string[]>
    expect(merged['@sparkelf/dsh-mineru@0.1.4']).toEqual(['0.2.2-rc.2', '0.2.3-rc.1'])
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
    expect(() => ensureProfile(paths, 'missing')).toThrow(/unknown edition "missing"/u)
  })
})
