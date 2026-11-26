/**
 * SOP → skill promotion is the one place where a memory draft becomes executable
 * guidance, so the contract has two safety properties worth pinning:
 *
 * - the skill name is a real kebab-case DSH skill name and cannot escape the
 *   skills root;
 * - the SOP file is removed only after a non-empty `SKILL.md` exists, so a failed
 *   promotion never loses the draft.
 *
 * The update case is also explicit: promoting the same name twice must overwrite
 * the existing skill and bump its version, not create a second directory.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deleteSopAfterPromotion,
  promoteSopToSkill,
  skillSlugFor,
  type SopDraft,
} from '../src/memorySkillPromotion.ts'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kb-skill-promotion-'))
  roots.push(directory)
  return directory
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function sop(overrides: Partial<SopDraft> = {}): SopDraft {
  return {
    id: 'sop-deploy-check',
    title: 'Deploy Check',
    description: '按顺序核对发布前置条件',
    body: '## 步骤\n\n1. 确认变更窗口\n2. 核对回滚点',
    slug: 'deploy-check',
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('promoteSopToSkill', () => {
  it('creates a kebab-case skill with the required front matter and the SOP body', async () => {
    const skillsRoot = await tempRoot()
    const result = await promoteSopToSkill({
      sop: sop({ description: 'Use "quotes": and: colons' }),
      skillsRoot,
      now: '2026-11-12T08:00:00.000Z',
    })

    expect(result).toBe(join(skillsRoot, 'deploy-check', 'SKILL.md'))
    const text = await readFile(result, 'utf8')
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toContain('name: deploy-check\n')
    expect(text).toContain('description: "Use \\"quotes\\": and: colons"\n')
    expect(text).toContain('version: 1\n')
    expect(text).toContain('sourceSop: "sop-deploy-check"\n')
    expect(text).toContain('promotedAt: "2026-11-12T08:00:00.000Z"\n')
    expect(text).toContain('## 步骤')
    expect(text).toContain('1. 确认变更窗口')
    // The atomic temp file must not survive the promotion.
    expect(await readdir(join(skillsRoot, 'deploy-check'))).toEqual(['SKILL.md'])
  })

  it('derives the slug from an ASCII title when no explicit slug is passed', async () => {
    const skillsRoot = await tempRoot()
    expect(skillSlugFor('Deploy Check')).toBe('deploy-check')
    const result = await promoteSopToSkill({
      sop: sop({ slug: undefined, title: 'Deploy Check' }),
      skillsRoot,
    })
    expect(result).toBe(join(skillsRoot, 'deploy-check', 'SKILL.md'))
    expect(await exists(result)).toBe(true)
  })

  it('updates an existing same-name skill in place and bumps its version', async () => {
    const skillsRoot = await tempRoot()
    const created = await promoteSopToSkill({ sop: sop(), skillsRoot })
    const updated = await promoteSopToSkill({
      sop: sop({ body: '## 步骤\n\n1. 只保留新的检查项' }),
      skillsRoot,
    })

    expect(updated).toBe(created)
    const text = await readFile(updated, 'utf8')
    expect(text).toContain('version: 2\n')
    expect(text).toContain('只保留新的检查项')
    expect(text).not.toContain('核对回滚点')
    expect(await readdir(skillsRoot)).toEqual(['deploy-check'])
  })

  it('rejects unsafe or non-kebab-case slugs without writing anything', async () => {
    const skillsRoot = await tempRoot()
    await mkdir(skillsRoot, { recursive: true })
    for (const slug of ['../escape', 'a/b', 'Bad Slug', '--leading', '-trailing-', '']) {
      await expect(promoteSopToSkill({ sop: sop({ slug }), skillsRoot }))
        .rejects.toMatchObject({ code: 'invalid-slug' })
    }
    await expect(promoteSopToSkill({
      sop: sop({ slug: undefined, title: '指标口径排查' }),
      skillsRoot,
    })).rejects.toMatchObject({ code: 'invalid-slug' })
    expect(await readdir(skillsRoot)).toEqual([])
  })

  it('rejects an empty SOP body', async () => {
    const skillsRoot = await tempRoot()
    await expect(promoteSopToSkill({ sop: sop({ body: '   ' }), skillsRoot }))
      .rejects.toMatchObject({ code: 'invalid-sop' })
  })
})

describe('deleteSopAfterPromotion', () => {
  it('removes the SOP only after the skill exists, and leaves the skill in place', async () => {
    const root = await tempRoot()
    const skillsRoot = join(root, 'skills')
    const sopPath = join(root, 'SOP', '发布检查.md')
    await mkdir(join(root, 'SOP'), { recursive: true })
    await writeFile(sopPath, '# 发布检查\n', 'utf8')

    const skillPath = await promoteSopToSkill({ sop: sop(), skillsRoot })
    await expect(deleteSopAfterPromotion({ sopPath, skillPath })).resolves.toBe(true)

    expect(await exists(sopPath)).toBe(false)
    expect(await exists(skillPath)).toBe(true)
    // Deleting an already-absent SOP after success is a no-op, not an error.
    await expect(deleteSopAfterPromotion({ sopPath, skillPath })).resolves.toBe(false)
  })

  it('keeps the SOP when the skill write did not exist', async () => {
    const root = await tempRoot()
    const sopPath = join(root, 'SOP', '未晋升.md')
    await mkdir(join(root, 'SOP'), { recursive: true })
    await writeFile(sopPath, '# 未晋升\n', 'utf8')
    const missingSkill = join(root, 'skills', 'missing', 'SKILL.md')

    await expect(deleteSopAfterPromotion({ sopPath, skillPath: missingSkill }))
      .rejects.toMatchObject({ code: 'skill-missing' })
    expect(await exists(sopPath)).toBe(true)
  })

  it('refuses a promotion path that is not a SKILL.md', async () => {
    const root = await tempRoot()
    const sopPath = join(root, 'SOP', 'x.md')
    await mkdir(join(root, 'SOP'), { recursive: true })
    await writeFile(sopPath, '# x\n', 'utf8')

    await expect(deleteSopAfterPromotion({
      sopPath,
      skillPath: join(root, 'skills', 'x', 'README.md'),
    })).rejects.toMatchObject({ code: 'invalid-path' })
    expect(await exists(sopPath)).toBe(true)
  })
})
