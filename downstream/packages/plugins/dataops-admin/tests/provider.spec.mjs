import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  apply, dataopsAdminSkillProvider, scriptPath, SKILL_DESCRIPTION, SKILL_DISPLAY_NAME,
  SKILL_NAME, SKILL_PROVIDER, skillPath,
} from '../lib/index.js'

describe('the skill provider', () => {
  it('names itself so the catalog can address it', () => {
    expect(dataopsAdminSkillProvider().name).toBe(SKILL_PROVIDER)
    expect(SKILL_PROVIDER).toBe('dsh-dataops-admin')
  })

  it('lists exactly one candidate under the name the model sees', async () => {
    const listed = await dataopsAdminSkillProvider().list({})
    expect(listed).toHaveLength(1)
    expect(listed[0].name).toBe(SKILL_NAME)
    expect(SKILL_NAME).toBe('dataops-admin')
  })

  it('reports a description without reading the body, as list() must', async () => {
    // The catalog answers list() for every skill; a description parsed out of the file
    // would make that pass read every SKILL.md on the host.
    const [candidate] = await dataopsAdminSkillProvider().list({})
    expect(candidate.description.length).toBeGreaterThan(30)
    expect(candidate.description).toContain('万相数据中台')
  })

  it('names the skill in the business brand, not the internal codename', () => {
    // The registry name stays ASCII (it keys the provider and must match the scanner's
    // directory pattern), but anything a reader sees uses the business name.
    expect(SKILL_DISPLAY_NAME).toBe('万相数据AI中台管理')
    expect(SKILL_NAME).toBe('dataops-admin')
    expect(SKILL_NAME).not.toBe(SKILL_DISPLAY_NAME)
  })

  it('describes itself in terms a user recognises', () => {
    expect(SKILL_DESCRIPTION).toContain('账号与权限')
    expect(SKILL_DESCRIPTION).toContain('超级管理员')
  })

  it('resolves SKILL.md relative to the build output, since lib/ sits one level down', () => {
    const path = skillPath()
    expect(path.endsWith('/SKILL.md')).toBe(true)
    expect(existsSync(path)).toBe(true)
  })

  it('resolves the script the document tells the model to run', () => {
    const path = scriptPath()
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('dataops-admin')
  })

  it('exposes the package root as resourceBase so scripts/ is reachable', async () => {
    // A relative `scripts/dataops-admin.mjs` in the body resolves against this.
    const [candidate] = await dataopsAdminSkillProvider().list({})
    expect(candidate.resourceBase.kind).toBe('directory')
    expect(existsSync(candidate.resourceBase.path)).toBe(true)
    expect(existsSync(`${candidate.resourceBase.path}/scripts/dataops-admin.mjs`)).toBe(true)
  })

  it('marks the skill bundled and invocable by both the model and a user', async () => {
    const [candidate] = await dataopsAdminSkillProvider().list({})
    expect(candidate.source).toBe('bundled')
    expect(candidate.invocation.modelInvocable).toBe(true)
    expect(candidate.invocation.userInvocable).toBe(true)
  })

  it('loads the body on get(), not on list()', async () => {
    const provider = dataopsAdminSkillProvider()
    const [candidate] = await provider.list({})
    const loaded = await provider.get(candidate, {})
    expect(loaded.content).toContain('# 万相数据AI中台管理')
    expect(loaded.content.length).toBeGreaterThan(500)
  })

  it('frontmatter carries a name and description the scanner accepts', () => {
    // The skill center requires a `description:` inside delimited frontmatter.
    const body = readFileSync(skillPath(), 'utf8')
    const front = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(body)
    expect(front).not.toBeNull()
    expect(/^\s*name\s*:\s*dataops-admin\s*$/mu.test(front[1])).toBe(true)
    expect(/^\s*description\s*:\s*\S/mu.test(front[1])).toBe(true)
  })

  it('names its directory with the pattern the scanner requires', () => {
    // ^[a-z0-9]+(?:-[a-z0-9]+)*$ -- a directory failing this is skipped silently.
    expect(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(SKILL_NAME)).toBe(true)
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
    // Copied guard from knowledge-base: the registry is optional, and apply() must not
    // take the plugin down on an older host.
    expect(() => apply({})).not.toThrow()
    expect(() => apply(undefined)).not.toThrow()
    expect(() => apply({ inject: 'not-a-function' })).not.toThrow()
  })

  it('does not register when inject is absent', () => {
    const host = { someOtherService: true }
    expect(() => apply(host)).not.toThrow()
    expect(host).toEqual({ someOtherService: true })
  })
})
