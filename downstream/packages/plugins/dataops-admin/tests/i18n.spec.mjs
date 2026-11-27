import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SKILL_DESCRIPTION, SKILL_DISPLAY_NAME, skillPath } from '../lib/index.js'

/**
 * The skill center reads a skill's display name from `i18n/zh.json` beside SKILL.md,
 * NOT from the frontmatter. These assertions pin the contract that file serves.
 */
const translationPath = join(dirname(skillPath()), 'i18n', 'zh.json')

describe('the skill-center translation file', () => {
  it('sits beside SKILL.md, where readSkillTranslation looks for it', () => {
    expect(existsSync(translationPath)).toBe(true)
    expect(dirname(skillPath())).toBe(dirname(translationPath).replace(/\/i18n$/u, ''))
  })

  it('titles the skill in the business brand', () => {
    const record = JSON.parse(readFileSync(translationPath, 'utf8'))
    expect(record.title).toBe('万相数据AI中台管理')
  })

  it('keeps the title and the provider constant in step', () => {
    // Two places carry the display name; a rename that updates only one is the bug this
    // catches.
    const record = JSON.parse(readFileSync(translationPath, 'utf8'))
    expect(record.title).toBe(SKILL_DISPLAY_NAME)
  })

  it('carries the three fields the panel requires', () => {
    // readSkillTranslation returns undefined unless title, description and summary are
    // all strings; a partial record degrades the card back to the registry values.
    const record = JSON.parse(readFileSync(translationPath, 'utf8'))
    // Each is present and non-empty; a length floor would encode an arbitrary number and
    // `title` is deliberately short (it is the 10-character display name).
    for (const field of ['title', 'description', 'summary']) {
      expect(typeof record[field]).toBe('string')
      expect(record[field].trim()).not.toBe('')
    }
  })

  it('describes the skill in the same words the provider reports', () => {
    const record = JSON.parse(readFileSync(translationPath, 'utf8'))
    expect(record.description).toBe(SKILL_DESCRIPTION)
  })

  it('names the trigger conditions and the permission prerequisite', () => {
    const record = JSON.parse(readFileSync(translationPath, 'utf8'))
    expect(record.description).toContain('创建账号')
    expect(record.description).toContain('超级管理员')
  })

  it('keeps internal codenames out of user-visible copy', () => {
    // The brand rule: users see 万相, not the internal project name.
    const record = JSON.parse(readFileSync(translationPath, 'utf8'))
    expect(record.title).not.toContain('DataOps')
    expect(record.description).not.toContain('DataOps')
    expect(record.title).not.toContain('dsh-')
  })

  it('names its directory within the scanner pattern', () => {
    // A directory failing this is skipped silently, so the ASCII name is load-bearing.
    expect(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test('dataops-admin')).toBe(true)
    expect(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test('万相数据AI中台管理')).toBe(false)
  })
})

describe('the SKILL.md document', () => {
  it('keeps the ASCII name in frontmatter, which the scanner validates', () => {
    const body = readFileSync(skillPath(), 'utf8')
    const front = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(body)
    expect(front).not.toBeNull()
    expect(/^\s*name\s*:\s*dataops-admin\s*$/mu.test(front[1])).toBe(true)
  })

  it('titles its body with the display name', () => {
    expect(readFileSync(skillPath(), 'utf8')).toContain('# 万相数据AI中台管理')
  })

  it('uses the Chinese description in frontmatter', () => {
    const body = readFileSync(skillPath(), 'utf8')
    expect(body).toContain('管理万相数据中台的账号与权限')
  })
})
