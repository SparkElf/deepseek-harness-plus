/**
 * Promote an evaluated memory SOP into a durable skill.
 *
 * The memory design keeps an SOP as a draft with an independent lifecycle
 * (`draft → testing → promoted / dropped`). Once the guardian session judges a
 * SOP effective, the SOP body becomes a skill under the user's skills root, and
 * the SOP file is removed only after that write has succeeded. Keeping the write
 * and the delete as two explicit steps is what makes the promotion auditable:
 * the caller can record `promotedTo`, and a failed skill write leaves the SOP
 * untouched for the next dream.
 *
 * The skill format is the Host's public one: a directory named by a kebab-case
 * skill name, containing `SKILL.md` with YAML front matter and the body. The
 * promotion never invents a second directory for an existing skill; promoting
 * the same name again updates that skill and increments its version.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-skill-promotion
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path'

/** The kebab-case grammar every DSH skill name must satisfy. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Longest skill name accepted; keeps directory names readable. */
const MAX_SKILL_NAME_LENGTH = 64

/** Machine-readable failure reasons for callers that branch on them. */
export type MemorySkillPromotionErrorCode =
  | 'invalid-sop'
  | 'invalid-slug'
  | 'invalid-path'
  | 'invalid-time'
  | 'skill-missing'

/** A promotion failure the guardian session should report, not retry blindly. */
export class MemorySkillPromotionError extends Error {
  constructor(readonly code: MemorySkillPromotionErrorCode, message: string) {
    super(message)
    this.name = 'MemorySkillPromotionError'
  }
}

/** One evaluated SOP draft, as the guardian session holds it in memory. */
export interface SopDraft {
  /** Stable SOP identity used for the audit trail and `sourceSop`. */
  id: string
  /** Human title; also the body heading context when the caller includes one. */
  title: string
  /** The SOP body: trigger, steps, tool choices and success criteria. */
  body: string
  /** One-line skill description; defaults to the title. */
  description?: string
  /** Explicit skill name. Required when the title has no ASCII words. */
  slug?: string
  /** Initial version when creating; an update always increments the existing one. */
  version?: number
}

/** Input for {@link promoteSopToSkill}. */
export interface PromoteSopInput {
  sop: SopDraft
  /** Directory that holds one sub-directory per skill. */
  skillsRoot: string
  /** Audit timestamp; defaults to the current instant. */
  now?: string | Date
}

/** Input for {@link deleteSopAfterPromotion}. */
export interface DeleteSopInput {
  /** Path of the SOP file the guardian is retiring. */
  sopPath: string
  /** Absolute path returned by the successful {@link promoteSopToSkill} call. */
  skillPath: string
}

/** Test whether an error is the filesystem's "not found" error. */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/** Reject an unusable skills root before anything is created. */
function checkedSkillsRoot(skillsRoot: string): string {
  if (typeof skillsRoot !== 'string' || skillsRoot.trim() === '' || skillsRoot.includes('\0')) {
    throw new MemorySkillPromotionError('invalid-path', 'a skills root is required')
  }
  const resolved = resolve(skillsRoot)
  if (resolved === parse(resolved).root) {
    throw new MemorySkillPromotionError('invalid-path', 'the filesystem root cannot be a skills root')
  }
  return resolved
}

/**
 * Derive a kebab-case skill name from a human title.
 *
 * Chinese-only titles produce an empty slug; the guardian must then pass an
 * explicit English `slug` rather than getting a silent hash-based directory.
 */
export function skillSlugFor(title: string): string {
  const slug = title.trim().toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  if (slug === '' || slug.length > MAX_SKILL_NAME_LENGTH || !SKILL_NAME.test(slug)) {
    throw new MemorySkillPromotionError(
      'invalid-slug',
      `cannot derive a kebab-case skill name from "${title}"; provide sop.slug explicitly`,
    )
  }
  return slug
}

/** Validate an explicit or derived slug. */
function checkedSlug(sop: SopDraft): string {
  if (sop.slug !== undefined && typeof sop.slug !== 'string') {
    throw new MemorySkillPromotionError('invalid-slug', 'a SOP slug must be a string')
  }
  const slug = sop.slug === undefined ? skillSlugFor(sop.title) : sop.slug.trim()
  if (slug.length === 0 || slug.length > MAX_SKILL_NAME_LENGTH || !SKILL_NAME.test(slug)) {
    throw new MemorySkillPromotionError('invalid-slug', `"${slug}" is not a kebab-case skill name`)
  }
  return slug
}

/** Validate the SOP content that will be written into the skill. */
function checkedSop(sop: SopDraft): {
  id: string
  description: string
  body: string
  version: number
} {
  if (typeof sop.id !== 'string' || sop.id.trim() === '') {
    throw new MemorySkillPromotionError('invalid-sop', 'a SOP id is required')
  }
  if (typeof sop.title !== 'string' || sop.title.trim() === '') {
    throw new MemorySkillPromotionError('invalid-sop', 'a SOP title is required')
  }
  if (typeof sop.body !== 'string' || sop.body.trim() === '') {
    throw new MemorySkillPromotionError('invalid-sop', 'a SOP body is required')
  }
  const version = sop.version ?? 1
  if (!Number.isInteger(version) || version < 1) {
    throw new MemorySkillPromotionError('invalid-sop', 'a SOP version must be a positive integer')
  }
  const description = (sop.description ?? sop.title).replace(/\s+/gu, ' ').trim()
  if (description === '') {
    throw new MemorySkillPromotionError('invalid-sop', 'a SOP description is required')
  }
  return { id: sop.id.trim(), description, body: sop.body.trim(), version }
}

/** Normalize the audit timestamp to an ISO-8601 instant. */
function checkedPromotedAt(now: string | Date | undefined): string {
  if (now === undefined) return new Date().toISOString()
  const date = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(date.getTime())) {
    throw new MemorySkillPromotionError('invalid-time', 'promotedAt must be a valid date')
  }
  return date.toISOString()
}

/** Quote one value so the hand-written YAML front matter cannot be broken by it. */
function yamlScalar(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return '"' + normalized.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"') + '"'
}

/** Read a previous skill's version, or undefined when it has no readable front matter. */
function previousVersion(source: string): number | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(source)
  if (front === null) return undefined
  const version = /^version:\s*(\d+)\s*$/mu.exec(front[1] ?? '')
  if (version === null) return undefined
  const parsed = Number.parseInt(version[1] ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** Compose the public skill document. */
function renderSkill(input: {
  name: string
  description: string
  version: number
  sourceSop: string
  promotedAt: string
  body: string
}): string {
  return [
    '---',
    `name: ${input.name}`,
    `description: ${yamlScalar(input.description)}`,
    `version: ${input.version}`,
    `sourceSop: ${yamlScalar(input.sourceSop)}`,
    `promotedAt: ${yamlScalar(input.promotedAt)}`,
    '---',
    '',
    input.body,
    '',
  ].join('\n')
}

/** Write a file through a same-directory temp file so a crash cannot split it. */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  const temporary = join(
    dirname(filePath),
    `.SKILL.md.tmp-${process.pid}-${randomBytes(8).toString('hex')}`,
  )
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, filePath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Promote one SOP draft to a skill, creating or updating it in place.
 *
 * @param input - the SOP, the skills root, and the audit instant.
 * @returns The absolute path of the written skill, for the audit trail.
 */
export async function promoteSopToSkill(input: PromoteSopInput): Promise<string> {
  const skillsRoot = checkedSkillsRoot(input.skillsRoot)
  // Validate the SOP before deriving a slug from its title, so a malformed draft
  // fails with a product-level error instead of a property access error.
  const sop = checkedSop(input.sop)
  const slug = checkedSlug(input.sop)
  const promotedAt = checkedPromotedAt(input.now)

  const target = join(skillsRoot, slug, 'SKILL.md')
  const relativeTarget = relative(skillsRoot, target).split(sep).join('/')
  if (relativeTarget !== slug + '/SKILL.md') {
    throw new MemorySkillPromotionError('invalid-path', 'the skill path escaped the skills root')
  }

  let existingSource: string | undefined
  try {
    existingSource = await readFile(target, 'utf8')
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  const created = existingSource === undefined
  const version = created ? sop.version : (previousVersion(existingSource ?? '') ?? 0) + 1

  await mkdir(join(skillsRoot, slug), { recursive: true })
  await writeAtomic(target, renderSkill({
    name: slug,
    description: sop.description,
    version,
    sourceSop: sop.id,
    promotedAt,
    body: sop.body,
  }))

  return target
}

/** Reject an unusable path before a delete can touch it. */
function checkedFilePath(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new MemorySkillPromotionError('invalid-path', `a ${label} path is required`)
  }
  return resolve(value)
}

/**
 * Remove the SOP file only after the promoted skill is verifiably on disk.
 *
 * A missing skill write is an error and leaves the SOP untouched, so the draft
 * cannot be lost to a failed promotion. Deleting an already-absent SOP after a
 * successful promotion is a no-op that returns false.
 *
 * @param input - the SOP path and the skill path that must exist.
 * @returns Whether a SOP file was actually removed.
 */
export async function deleteSopAfterPromotion(input: DeleteSopInput): Promise<boolean> {
  const sopPath = checkedFilePath(input.sopPath, 'SOP')
  const skillPath = checkedFilePath(input.skillPath, 'skill')
  if (basename(skillPath) !== 'SKILL.md') {
    throw new MemorySkillPromotionError('invalid-path', 'a promotion path must point at a SKILL.md')
  }
  if (!basename(sopPath).toLowerCase().endsWith('.md')) {
    throw new MemorySkillPromotionError('invalid-path', 'a SOP path must be a Markdown file')
  }
  if (sopPath === skillPath) {
    throw new MemorySkillPromotionError('invalid-path', 'the SOP and the skill cannot be the same file')
  }

  let skill
  try {
    skill = await stat(skillPath)
  } catch (error) {
    if (isNotFound(error)) {
      throw new MemorySkillPromotionError('skill-missing', 'the promoted skill is not on disk; the SOP was kept')
    }
    throw error
  }
  if (!skill.isFile() || skill.size === 0) {
    throw new MemorySkillPromotionError('skill-missing', 'the promoted skill is empty; the SOP was kept')
  }

  try {
    await rm(sopPath)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}
