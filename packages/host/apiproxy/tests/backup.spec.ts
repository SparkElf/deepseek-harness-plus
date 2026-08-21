import { zipSync } from 'fflate'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BACKUP_MANIFEST_ENTRY, restoreUserBackup, validateUserBackup, writeUserBackup } from '../src/backup.ts'

function bytes(entries: Record<string, string>): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  for (const [name, content] of Object.entries(entries)) files[name] = new TextEncoder().encode(content)
  return zipSync(files)
}

describe('user data backup', () => {
  let work: string
  let home: string

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'dsh-web-backup-'))
    home = join(work, 'home')
    mkdirSync(join(home, 'storages'), { recursive: true })
    mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true })
    mkdirSync(join(home, 'supervisor'), { recursive: true })
    writeFileSync(join(home, 'settings.yaml'), 'agent-default-model:\n  model: m\n')
    writeFileSync(join(home, '.credentials.yaml'), 'K: sk-value\n')
    writeFileSync(join(home, 'storages', 'workspace.json'), '{}')
    writeFileSync(join(home, 'profiles', 'node_modules', 'generated.txt'), 'x')
    writeFileSync(join(home, 'supervisor', 'runtime.log'), 'log')
  })

  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('writes user data with the marker and skips generated directories and symlinks', () => {
    symlinkSync(join(home, 'nowhere'), join(home, 'dangling'))
    const archivePath = join(work, 'backup.zip')
    const written = writeUserBackup(home, archivePath)
    expect(written.entries).toBeGreaterThan(0)
    const names = Object.keys(validateUserBackup(new Uint8Array(readFileSync(archivePath))).entries)
    expect(names).toContain('settings.yaml')
    expect(names).toContain('.credentials.yaml')
    expect(names).toContain('storages/workspace.json')
    expect(names).toContain(BACKUP_MANIFEST_ENTRY)
    expect(names.some(name => name.startsWith('profiles/'))).toBe(false)
    expect(names.some(name => name.startsWith('supervisor/'))).toBe(false)
    expect(names).not.toContain('dangling')
  })

  it('rejects archives without the manifest marker', () => {
    expect(() => validateUserBackup(bytes({ 'settings.yaml': 'x' }))).toThrow('missing ' + BACKUP_MANIFEST_ENTRY)
  })

  it.each([
    ['absolute', { '/evil.txt': 'x' }],
    ['backslash', { 'a\\evil.txt': 'x' }],
    ['traversal', { '../evil.txt': 'x' }],
    ['empty segment', { 'a//b.txt': 'x' }],
  ])('rejects archives with an %s entry path', (_label, evil) => {
    expect(() => validateUserBackup(bytes({ ...evil, [BACKUP_MANIFEST_ENTRY]: '{}' }))).toThrow('unsafe path')
  })

  it('restores same-named files over the harness home and keeps the rest', () => {
    const archivePath = join(work, 'backup.zip')
    writeUserBackup(home, archivePath)
    writeFileSync(join(home, 'settings.yaml'), 'tampered: true\n')
    writeFileSync(join(home, 'storages', 'workspace.json'), 'tampered')
    writeFileSync(join(home, 'keep.txt'), 'kept')
    const restored = restoreUserBackup(validateUserBackup(new Uint8Array(readFileSync(archivePath))), home)
    expect(restored.entries).toBeGreaterThan(0)
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toContain('agent-default-model')
    expect(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8')).toBe('{}')
    expect(readFileSync(join(home, 'keep.txt'), 'utf8')).toBe('kept')
  })
})
