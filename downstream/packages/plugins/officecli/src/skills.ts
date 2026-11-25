import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

/**
 * The nine OfficeCLI workflow skills, using the names the official CLI accepts for
 * `officecli load_skill <name>`. They all ship in this package because the OfficeCLI
 * binary is already the plugin's dependency: a separate skill package would pin the
 * same binary twice and still need this tool to do any work.
 */
export const BUNDLED_SKILLS = [
  'word',
  'excel',
  'pptx',
  'word-form',
  'morph-ppt',
  'pitch-deck',
  'academic-paper',
  'data-dashboard',
  'financial-model',
] as const

export type BundledSkillName = (typeof BUNDLED_SKILLS)[number]

const INVOCATION = { modelInvocable: true, userInvocable: true } as const

/** Absolute path of one bundled SKILL.md; `import.meta.url` is `lib/index.js` at runtime. */
export function skillFile(name: BundledSkillName): string {
  return fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url))
}

/** Absolute directory of one bundled skill, used as the base for `reference/...` paths. */
function skillDirectory(name: BundledSkillName): string {
  return fileURLToPath(new URL(`../skills/${name}/`, import.meta.url))
}

/** Split a skill file into its frontmatter block and body. */
function splitFrontmatter(raw: string): { front: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (match === null) return { front: '', body: raw }
  return { front: match[1] ?? '', body: raw.slice(match[0].length) }
}

/** Read one simple frontmatter field such as `description`. */
function frontmatterField(front: string, key: string): string | undefined {
  const line = new RegExp('^\\s*' + key + '\\s*:\\s*(.+?)\\s*$', 'mu').exec(front)
  return line?.[1]?.replace(/^['"]|['"]$/gu, '')
}

function descriptionOf(name: BundledSkillName): string {
  const raw = readFileSync(skillFile(name), 'utf8')
  const description = frontmatterField(splitFrontmatter(raw).front, 'description')
  if (description === undefined) throw new Error(`${name} SKILL.md frontmatter has no description`)
  return description
}

function candidateOf(name: BundledSkillName): SkillCandidate {
  return {
    name,
    path: skillFile(name),
    description: descriptionOf(name),
    invocation: INVOCATION,
    provider: `officecli-${name}`,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: skillDirectory(name) },
    rank: BUNDLED_SKILL_RANK,
    locator: skillFile(name),
  }
}

/** Build one provider per skill so a bad file fails only that skill's catalog entry. */
export function createSkillProviders(): SkillProvider[] {
  return BUNDLED_SKILLS.map((name) => {
    const candidate = candidateOf(name)
    return {
      name: `officecli-${name}`,
      list: () => Promise.resolve([candidate]),
      async get(): Promise<SkillDefinition> {
        const raw = await readFile(skillFile(name), 'utf8')
        return {
          name: candidate.name,
          path: candidate.path,
          description: candidate.description,
          invocation: candidate.invocation,
          provider: candidate.provider,
          source: candidate.source,
          resourceBase: candidate.resourceBase,
          content: splitFrontmatter(raw).body.trim(),
        }
      },
    }
  })
}

/**
 * Resolve `officecli load_skill <name>` to this package's customized text.
 *
 * The binary ships the upstream SKILL.md unchanged, so letting that subcommand through
 * would bypass the GB/T 9704 and Wanxiang-brand rules the DSH skill body adds. Returning
 * the bundled file keeps both entry points on the same text.
 *
 * @param command - argv passed to the officecli tool.
 * @returns the bundled SKILL.md when the command names one of the nine skills, otherwise undefined.
 */
export function bundledSkillText(command: readonly string[]): string | undefined {
  if (command[0] !== 'load_skill') return undefined
  const requested = command[1]
  if (requested === undefined) return undefined
  if (!(BUNDLED_SKILLS as readonly string[]).includes(requested)) return undefined
  return readFileSync(skillFile(requested as BundledSkillName), 'utf8').trim()
}