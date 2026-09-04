import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  materializeOfficialPackageScope,
  parseOfficialWorkspacePackages,
} from '../src/apply.ts'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plus-official-scope-'))
  fixtures.push(root)
  return root
}

describe('Plus official package scope', () => {
  it('loads the Subagent Settings client beside its two Host schema owners', () => {
    const manifest = JSON.parse(readFileSync(
      fileURLToPath(new URL('../package.json', import.meta.url)),
      'utf8',
    )) as { dshPlus: { profile: { bundles: string[] } } }
    const subagentManifest = JSON.parse(readFileSync(
      fileURLToPath(new URL('../../../plus/subagent-settings/package.json', import.meta.url)),
      'utf8',
    )) as { dsh: { client: unknown } }
    const plusPatch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')

    expect(manifest.dshPlus.profile.bundles).not.toContain('@sparkelf/dsh-plugin-subagent-settings')
    expect(subagentManifest.dsh.client).toBeDefined()
    expect(plusPatch).toContain("id: plus-subagent-settings-client\n      name: '@sparkelf/dsh-plugin-subagent-settings'")
    expect(plusPatch).toContain("id: plus-subagent-settings\n      name: '@sparkelf/dsh-plugin-subagent-settings/startup'")
    expect(plusPatch).toContain("id: plus-subagent-fork-settings\n      name: '@sparkelf/dsh-plugin-subagent-settings/startup'")
  })

  it('parses, scopes, and sorts the official workspace roster', () => {
    const root = fixture()
    const attachment = join(root, 'packages/attachment/attachment')
    const timeout = join(root, 'packages/util/timeout')

    expect(parseOfficialWorkspacePackages(root, JSON.stringify([
      { name: '@deepseek-ai/dsh-timeout', path: timeout },
      { name: '@external/plugin', path: join(root, 'external/plugin') },
      { name: '@deepseek-ai/dsh-attachment', path: attachment },
    ]))).toEqual([
      { name: '@deepseek-ai/dsh-attachment', directory: attachment },
      { name: '@deepseek-ai/dsh-timeout', directory: timeout },
    ])
  })

  it('rejects workspace packages outside the exact official source root', () => {
    const root = fixture()

    expect(() => parseOfficialWorkspacePackages(root, JSON.stringify([
      { name: '@deepseek-ai/dsh-timeout', path: join(root, '../outside') },
    ]))).toThrow('escapes DSH root')
  })

  it('unions CLI dependencies with official workspaces and keeps CLI precedence', () => {
    const root = fixture()
    const cliScope = join(root, 'source/apps/cli/node_modules/@deepseek-ai')
    const cliTools = join(cliScope, 'dsh-tools')
    const workspaceTools = join(root, 'source/packages/core/tools')
    const workspaceAttachment = join(root, 'source/packages/attachment/attachment')
    const profile = join(root, 'profile')
    for (const directory of [cliTools, workspaceTools, workspaceAttachment, join(profile, 'node_modules')]) {
      mkdirSync(directory, { recursive: true })
    }

    materializeOfficialPackageScope(profile, cliScope, [
      { name: '@deepseek-ai/dsh-attachment', directory: workspaceAttachment },
      { name: '@deepseek-ai/dsh-tools', directory: workspaceTools },
    ])

    const scope = join(profile, 'node_modules/@deepseek-ai')
    expect(lstatSync(scope).isDirectory()).toBe(true)
    expect(realpathSync(join(scope, 'dsh-tools'))).toBe(realpathSync(cliTools))
    expect(realpathSync(join(scope, 'dsh-attachment'))).toBe(realpathSync(workspaceAttachment))
  })
})
