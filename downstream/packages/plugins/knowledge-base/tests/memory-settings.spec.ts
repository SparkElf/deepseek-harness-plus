import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_CONSOLIDATION_INTERVAL_DEFAULT,
  MEMORY_SETTINGS_FILE,
  MemorySettingsError,
  MemorySettingsStore,
  normalizeConsolidationInterval,
} from '../src/memorySettings.ts'

const roots: string[] = []

async function tempUsersRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kb-memory-settings-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MemorySettingsStore', () => {
  it('defaults to paused with a 60-minute interval for a user with no settings file', async () => {
    const usersRoot = await tempUsersRoot()
    const store = new MemorySettingsStore(usersRoot)

    expect(store.filePath('u1')).toBe(join(usersRoot, 'u1', MEMORY_SETTINGS_FILE))
    expect(await store.read('u1')).toEqual({
      version: 2,
      memoryEnabled: false,
      consolidationIntervalMinutes: MEMORY_CONSOLIDATION_INTERVAL_DEFAULT,
    })
    expect(await store.read('u2')).toEqual({ ...DEFAULT_MEMORY_SETTINGS })
    expect(await store.isEnabled('u1')).toBe(false)
    // A read never creates a file.
    await expect(readFile(store.filePath('u1'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('applies an injected administrator default only when no settings file exists', async () => {
    const usersRoot = await tempUsersRoot()
    const store = new MemorySettingsStore(usersRoot, {
      memoryEnabled: userId => userId === 'admin',
    })

    expect(await store.read('admin')).toMatchObject({
      memoryEnabled: true,
      consolidationIntervalMinutes: 60,
    })
    // The first read still does not create the file.
    await expect(readFile(store.filePath('admin'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await store.read('member')).toMatchObject({ memoryEnabled: false })
  })

  it('keeps an explicit false written by an administrator across store instances', async () => {
    const usersRoot = await tempUsersRoot()
    const policy = { memoryEnabled: () => true }
    const first = new MemorySettingsStore(usersRoot, policy)

    expect(await first.isEnabled('admin')).toBe(true)
    expect(await first.setEnabled('admin', false)).toMatchObject({
      memoryEnabled: false,
      consolidationIntervalMinutes: 60,
    })
    expect(JSON.parse(await readFile(first.filePath('admin'), 'utf8'))).toEqual({
      version: 2,
      memoryEnabled: false,
      consolidationIntervalMinutes: 60,
    })

    // A second instance with the same administrator policy must read the
    // explicit choice, not the default.
    const second = new MemorySettingsStore(usersRoot, policy)
    expect(await second.isEnabled('admin')).toBe(false)
    expect(await second.save('admin', { consolidationIntervalMinutes: 30 })).toMatchObject({
      memoryEnabled: false,
      consolidationIntervalMinutes: 30,
    })
    expect(await second.isEnabled('admin')).toBe(false)
  })

  it('never applies the administrator default over an existing version-1 false', async () => {
    const usersRoot = await tempUsersRoot()
    const store = new MemorySettingsStore(usersRoot, { memoryEnabled: () => true })
    await mkdir(join(usersRoot, 'admin'), { recursive: true })
    await writeFile(store.filePath('admin'), '{"version":1,"memoryEnabled":false}', 'utf8')

    expect(await store.isEnabled('admin')).toBe(false)
    expect(await store.read('admin')).toMatchObject({
      memoryEnabled: false,
      consolidationIntervalMinutes: 60,
    })
  })

  it('round-trips enable, pause and interval in one atomic write', async () => {
    const usersRoot = await tempUsersRoot()
    const store = new MemorySettingsStore(usersRoot)

    expect(await store.setEnabled('u1', true)).toEqual({
      version: 2,
      memoryEnabled: true,
      consolidationIntervalMinutes: 60,
    })
    expect(await store.read('u1')).toMatchObject({ memoryEnabled: true })
    expect(JSON.parse(await readFile(store.filePath('u1'), 'utf8'))).toEqual({
      version: 2,
      memoryEnabled: true,
      consolidationIntervalMinutes: 60,
    })

    expect(await store.setConsolidationInterval('u1', 30)).toMatchObject({
      memoryEnabled: true,
      consolidationIntervalMinutes: 30,
    })
    expect(await store.setEnabled('u1', false)).toMatchObject({
      memoryEnabled: false,
      consolidationIntervalMinutes: 30,
    })
    // One settings file, and no temp file left behind by the tmp+rename write.
    expect(await readdir(join(usersRoot, 'u1'))).toEqual([MEMORY_SETTINGS_FILE])
  })

  it('writes a complete file under concurrent saves', async () => {
    const usersRoot = await tempUsersRoot()
    const store = new MemorySettingsStore(usersRoot)

    await Promise.all(Array.from({ length: 12 }, (_, index) => (
      store.save('u1', {
        memoryEnabled: index % 2 === 0,
        consolidationIntervalMinutes: 15 + index,
      })
    )))

    const parsed = JSON.parse(await readFile(store.filePath('u1'), 'utf8')) as Record<string, unknown>
    expect(parsed.version).toBe(2)
    expect(typeof parsed.memoryEnabled).toBe('boolean')
    expect(parsed.consolidationIntervalMinutes).toBeGreaterThanOrEqual(15)
    expect(parsed.consolidationIntervalMinutes).toBeLessThanOrEqual(26)
    expect(await readdir(join(usersRoot, 'u1'))).toEqual([MEMORY_SETTINGS_FILE])
  })

  it('accepts interval boundaries and rejects values outside the guard', async () => {
    const usersRoot = await tempUsersRoot()
    const store = new MemorySettingsStore(usersRoot)

    expect(await store.setConsolidationInterval('u1', 15)).toMatchObject({ consolidationIntervalMinutes: 15 })
    expect(await store.setConsolidationInterval('u1', 1440)).toMatchObject({ consolidationIntervalMinutes: 1440 })
    for (const value of [14, 1441, 30.5, Number.NaN, 0, -1]) {
      await expect(store.setConsolidationInterval('u1', value)).rejects.toBeInstanceOf(MemorySettingsError)
    }
    await expect(store.setConsolidationInterval('u1', '30' as never)).rejects.toBeInstanceOf(MemorySettingsError)
    expect(normalizeConsolidationInterval(15)).toBe(15)
    expect(normalizeConsolidationInterval(1440)).toBe(1440)
  })

  it('reads a version-1 file without losing the explicit switch', async () => {
    const usersRoot = await tempUsersRoot()
    const store = new MemorySettingsStore(usersRoot)
    await mkdir(join(usersRoot, 'u1'), { recursive: true })

    await writeFile(store.filePath('u1'), '{"version":1,"memoryEnabled":true}', 'utf8')
    expect(await store.read('u1')).toEqual({
      version: 2,
      memoryEnabled: true,
      consolidationIntervalMinutes: 60,
    })

    await writeFile(store.filePath('u1'), '{"memoryEnabled":false}', 'utf8')
    expect(await store.read('u1')).toMatchObject({
      memoryEnabled: false,
      consolidationIntervalMinutes: 60,
    })

    // A malformed interval must not change the remembered switch.
    await writeFile(
      store.filePath('u1'),
      '{"version":1,"memoryEnabled":true,"consolidationIntervalMinutes":"soon"}',
      'utf8',
    )
    expect(await store.read('u1')).toMatchObject({
      memoryEnabled: true,
      consolidationIntervalMinutes: 60,
    })
  })

  it('treats malformed or shape-invalid files as paused, and repairs them on write', async () => {
    const usersRoot = await tempUsersRoot()
    const store = new MemorySettingsStore(usersRoot, { memoryEnabled: () => true })
    await mkdir(join(usersRoot, 'u1'), { recursive: true })

    await writeFile(store.filePath('u1'), '{not json', 'utf8')
    expect(await store.read('u1')).toEqual({ ...DEFAULT_MEMORY_SETTINGS })

    await writeFile(store.filePath('u1'), '[]', 'utf8')
    expect(await store.isEnabled('u1')).toBe(false)

    await writeFile(store.filePath('u1'), '{"memoryEnabled":"yes"}', 'utf8')
    expect(await store.isEnabled('u1')).toBe(false)

    await store.setEnabled('u1', true)
    expect(await store.read('u1')).toMatchObject({ memoryEnabled: true })
  })

  it('refuses unsafe user ids before touching the filesystem', async () => {
    const usersRoot = await tempUsersRoot()
    const store = new MemorySettingsStore(usersRoot)

    expect(() => store.filePath('../escape')).toThrow()
    await expect(store.read('../escape')).rejects.toThrow()
    await expect(store.setEnabled('../escape', true)).rejects.toThrow()
  })

  it('rejects an empty usersRoot and non-boolean values', async () => {
    expect(() => new MemorySettingsStore('')).toThrow()
    const usersRoot = await tempUsersRoot()
    const store = new MemorySettingsStore(usersRoot)
    await expect(store.setEnabled('u1', 'true' as never)).rejects.toThrow()
    await expect(store.save('u1', {})).rejects.toBeInstanceOf(MemorySettingsError)
  })
})
