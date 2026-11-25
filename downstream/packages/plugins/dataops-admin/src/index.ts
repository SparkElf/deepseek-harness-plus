/**
 * Host half of the DataOps administration skill.
 *
 * The package ships two files that the model needs: `SKILL.md` (how to drive the
 * script, what the permission boundary is) and `scripts/dataops-admin.mjs` (the script
 * itself). Neither lives under a directory the skill registry scans -- `node_modules`
 * is not a scan root -- so this plugin registers them explicitly, the same way
 * `@sparkelf/dsh-knowledge-base` does.
 *
 * There is no browser half and no client bundle: the skill is documentation plus a
 * command-line script, so nothing needs to render.
 *
 * @module @sparkelf/dsh-dataops-admin
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The name this plugin mounts as in the profile composition. */
export const PLUGIN_NAME = '@sparkelf/dsh-dataops-admin'

/** Provider name reported to the skill registry. */
export const SKILL_PROVIDER = 'dsh-dataops-admin'

/** Name the model sees in the skill catalog. */
export const SKILL_NAME = 'dataops-admin'

/**
 * Short description shown in the skill list.
 *
 * Kept beside the SKILL.md body rather than parsed out of its frontmatter: the catalog
 * answers `list()` without reading any skill content, so the text has to be available
 * without touching the file.
 */
export const SKILL_DESCRIPTION =
  '管理万相数据中台的账号与权限：创建账号、调整角色、重置密码、查询用户与角色。需要超级管理员账号凭据。'

/**
 * Display name the skill center shows for this skill.
 *
 * Deliberately NOT the registry name: `dataops-admin` is the internal identifier (it has
 * to match `^[a-z0-9]+(?:-[a-z0-9]+)*$`, and it keys the provider), while users must see
 * the business brand. The skill center reads the display name from the `i18n/zh.json`
 * beside SKILL.md; this constant is the same string, so a host that reports the catalog
 * without the translation file still has the right name to show.
 */
export const SKILL_DISPLAY_NAME = '万相数据AI中台管理'

/**
 * Where this package's SKILL.md lives, from either build layout.
 *
 * The build emits `lib/index.js` while a source run executes from `src/`; both sit one
 * level below the package root, so the same `..` answers both.
 *
 * @returns absolute path of the skill document.
 */
export function skillPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md')
}

/**
 * Where the CLI script lives.
 *
 * `resourceBase` below points at the package root, so the model can reach
 * `scripts/dataops-admin.mjs` relative to it. This export exists for tests and for
 * diagnostics that need the absolute path.
 *
 * @returns absolute path of the script.
 */
export function scriptPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'dataops-admin.mjs')
}

/** Both a human and the model may invoke this skill. */
export const SKILL_INVOCATION = { modelInvocable: true, userInvocable: true } as const

/**
 * Rank places this after the built-in skills and beside the other bundled ones.
 *
 * `knowledge-base` uses 640; this one sits next to it because both are DataOps
 * capabilities the model reaches for by name rather than by browsing.
 */
export const SKILL_RANK = 641

/**
 * One catalog entry, shaped like the host's `SkillCandidate`.
 *
 * Declared here instead of imported: this plugin does not depend on the skill package
 * (the registry is an optional injection), so the structural contract is restated
 * rather than turning an optional neighbour into a build requirement. The registry
 * merges these by the fields it reads, so a shape that satisfies them is the whole
 * contract.
 */
export interface SkillCandidateLike {
  readonly name: string
  readonly description: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly source: 'bundled'
  readonly provider: string
  readonly path: string
  readonly resourceBase: { readonly kind: 'directory'; readonly path: string }
  readonly rank: number
  readonly locator: string
}

/** One loaded skill, shaped like the host's `SkillDefinition`. */
export interface SkillDefinitionLike extends SkillCandidateLike {
  readonly content: string
}

/**
 * The skill provider that teaches the model how to administer DataOps.
 *
 * One bundled skill, read from disk on `get()` rather than kept in memory: the body is
 * documentation, and a host that never asks for it should not pay for it.
 *
 * `resourceBase` is the package root, so a relative reference to
 * `scripts/dataops-admin.mjs` in the SKILL.md body resolves for the reader.
 *
 * @returns a provider the skill registry can register.
 */
export function dataopsAdminSkillProvider(): {
  readonly name: string
  readonly list: (options: { readonly cwd?: string; readonly signal?: AbortSignal }) => Promise<readonly SkillCandidateLike[]>
  readonly get: (candidate: SkillCandidateLike, options: { readonly cwd?: string; readonly signal?: AbortSignal }) => Promise<SkillDefinitionLike | undefined>
} {
  const path = skillPath()
  const candidate: SkillCandidateLike = {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    invocation: SKILL_INVOCATION,
    source: 'bundled',
    provider: SKILL_PROVIDER,
    path,
    resourceBase: { kind: 'directory', path: dirname(path) },
    rank: SKILL_RANK,
    locator: path,
  }
  return {
    name: SKILL_PROVIDER,
    list: () => Promise.resolve([candidate]),
    get: () => Promise.resolve({ ...candidate, content: readFileSync(path, 'utf8') }),
  }
}

/**
 * Mount the skill provider on a host context.
 *
 * `inject` rather than a hard dependency entry, and the `typeof` guard around it, are
 * both copied from `@sparkelf/dsh-knowledge-base`: the skill registry is an optional
 * neighbour, and calling `inject` on a host that does not expose it would throw during
 * apply and take the whole plugin down. The dependency fiber starts when a registry
 * becomes available and unloads before either side is replaced.
 *
 * @param host - the plugin context.
 */
export function apply(host: unknown): void {
  // The null check comes first, and is not redundant with the `typeof` test below: on an
  // `undefined`/`null` host the property read itself throws, so a guard written only
  // around `inject` would take the plugin down instead of skipping the registration.
  if (host === null || host === undefined) return
  const hostWithInject = host as {
    inject?: (deps: readonly string[], run: (scoped: { skills: { registerProvider: (provider: () => unknown) => unknown } }) => void) => void
  }
  if (typeof hostWithInject.inject !== 'function') return
  hostWithInject.inject(['skills'], (scoped) => {
    scoped.skills.registerProvider(() => dataopsAdminSkillProvider() as never)
  })
}
