import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  apply, inject, ocrSkillProvider, skillPath, SKILL_DESCRIPTION, SKILL_DISPLAY_NAME,
  SKILL_NAME, SKILL_PROVIDER, Config,
} from '../lib/index.js'

describe('the skill provider', () => {
  it('names itself so the catalog can address it', () => {
    expect(ocrSkillProvider().name).toBe(SKILL_PROVIDER)
    expect(SKILL_PROVIDER).toBe('dsh-ocr')
  })

  it('lists exactly one candidate under the name the model sees', async () => {
    const listed = await ocrSkillProvider().list({})
    expect(listed).toHaveLength(1)
    expect(listed[0].name).toBe(SKILL_NAME)
    expect(SKILL_NAME).toBe('ocr')
  })

  it('reports a description without reading the body, as list() must', async () => {
    // The catalog answers list() for every skill; a description parsed out of the file
    // would make that pass read every SKILL.md on the host.
    const [candidate] = await ocrSkillProvider().list({})
    expect(candidate.description.length).toBeGreaterThan(30)
    expect(candidate.description).toContain('MinerU')
  })

  it('names the skill in the business brand, not the internal codename', () => {
    expect(SKILL_DISPLAY_NAME).toBe('文档文字识别')
    expect(SKILL_NAME).toBe('ocr')
    expect(SKILL_NAME).not.toBe(SKILL_DISPLAY_NAME)
  })

  it('resolves SKILL.md relative to the build output, since lib/ sits one level down', () => {
    const path = skillPath()
    expect(path.endsWith('/SKILL.md')).toBe(true)
    expect(existsSync(path)).toBe(true)
  })

  it('exposes the skill directory as resourceBase so i18n/ is reachable', async () => {
    // The skill center reads `i18n/zh.json` beside SKILL.md; a resourceBase pointing
    // anywhere else would leave the card showing the registry name.
    const [candidate] = await ocrSkillProvider().list({})
    expect(candidate.resourceBase.kind).toBe('directory')
    expect(existsSync(`${candidate.resourceBase.path}/i18n/zh.json`)).toBe(true)
  })

  it('marks the skill bundled and invocable by both the model and a user', async () => {
    const [candidate] = await ocrSkillProvider().list({})
    expect(candidate.source).toBe('bundled')
    expect(candidate.invocation.modelInvocable).toBe(true)
    expect(candidate.invocation.userInvocable).toBe(true)
  })

  it('loads the body on get(), not on list()', async () => {
    const provider = ocrSkillProvider()
    const [candidate] = await provider.list({})
    const loaded = await provider.get(candidate, {})
    expect(loaded.content).toContain('# 文档文字识别')
    expect(loaded.content.length).toBeGreaterThan(500)
  })

  it('frontmatter carries a name and description the scanner accepts', () => {
    const body = readFileSync(skillPath(), 'utf8')
    const front = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(body)
    expect(front).not.toBeNull()
    expect(/^\s*name\s*:\s*ocr\s*$/mu.test(front[1])).toBe(true)
    expect(/^\s*description\s*:\s*\S/mu.test(front[1])).toBe(true)
  })

  it('names its directory with the pattern the scanner requires', () => {
    // ^[a-z0-9]+(?:-[a-z0-9]+)*$ -- a directory failing this is skipped silently.
    expect(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(SKILL_NAME)).toBe(true)
  })

  it('teaches the model to read the address instead of asking the user for it', () => {
    // The whole point of the shared value: a member must never be told to type it.
    const body = readFileSync(skillPath(), 'utf8')
    expect(body).toContain('/api/ocr/config')
    expect(body).toContain('不要问用户')
  })
})

describe('mounting on a host', () => {
  it('registers a provider through inject', () => {
    const registerProvider = vi.fn()
    const inject = vi.fn((_deps, run) => { run({ skills: { registerProvider } }) })
    apply({ inject })
    expect(inject).toHaveBeenCalledWith(['skills'], expect.any(Function))
    expect(registerProvider).toHaveBeenCalledTimes(1)
  })

  it('the registered factory yields the provider with the expected name', () => {
    const registerProvider = vi.fn()
    const inject = vi.fn((_deps, run) => { run({ skills: { registerProvider } }) })
    apply({ inject })
    const factory = registerProvider.mock.calls[0][0]
    expect(factory().name).toBe(SKILL_PROVIDER)
  })

  it('stays inert on a host without inject instead of throwing', () => {
    // The registry is optional, and apply() must not take the plugin down on a host that
    // does not expose it. Both guards are load-bearing: the null check first, then typeof.
    expect(() => apply({})).not.toThrow()
    expect(() => apply(undefined)).not.toThrow()
    expect(() => apply(null)).not.toThrow()
    expect(() => apply({ inject: 'not-a-function' })).not.toThrow()
  })

  it('does not mutate a host that has nothing to register into', () => {
    const host = { someOtherService: true }
    expect(() => apply(host)).not.toThrow()
    expect(host).toEqual({ someOtherService: true })
  })

  it('declares the host services apply reaches for', () => {
    // Cordis resolves a service through the plugin's own context, and touching one that
    // was not injected throws "cannot get property X without inject" DURING apply -- which
    // took the whole plugin down, skill registration included. Measured on the first
    // deployment: `ocr (@sparkelf/dsh-ocr): cannot get property "webServer" without inject`.
    expect(inject).toContain('webServer')
    expect(inject).toContain('credentials')
    // `skills` stays out: the registry is optional and reached through ctx.inject inside
    // apply, so requiring it would make the plugin fail on a host without one.
    expect(inject).not.toContain('skills')
  })

  it('skips the relay when the host has no webserver', () => {
    // Half a host still registers the skill; only the settings relay is skipped.
    const registerProvider = vi.fn()
    const inject = vi.fn((_deps, run) => { run({ skills: { registerProvider } }) })
    expect(() => apply({ inject })).not.toThrow()
    expect(registerProvider).toHaveBeenCalledTimes(1)
  })
})

describe('the deployment config', () => {
  it('defaults the backend address to empty, so an unconfigured deployment says so', () => {
    const parsed = new Config({})
    expect(parsed.baseUrl).toBe('')
  })

  it('defaults the credential to the DataOps session token', () => {
    expect(new Config({}).credentialRef).toBe('DATAOPS_ACCESS_TOKEN')
  })

  it('bounds one backend call', () => {
    expect(new Config({}).timeoutMs).toBe(15_000)
  })

  it('accepts a configured backend address', () => {
    expect(new Config({ baseUrl: 'http://host.docker.internal:8080' }).baseUrl)
      .toBe('http://host.docker.internal:8080')
  })
})

describe('the package manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

  it('ships the translation file the skill center reads', () => {
    // `pnpm pack` only includes what `files[]` names. Omitting i18n is how a packaged
    // skill silently loses its display name.
    expect(manifest.files).toContain('i18n/*.json')
    expect(manifest.files).toContain('SKILL.md')
  })

  it('declares the client half so the Web shell loads it', () => {
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.exports['./client'].default).toBe('./lib/client.js')
    expect(manifest.files).toContain('lib/client.js')
  })

  it('declares the bundle patch so the Host half mounts', () => {
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toContain('cordis.patch.yml')
  })
})
