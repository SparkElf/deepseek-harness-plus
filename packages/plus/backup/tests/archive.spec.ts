/**
 * Backup archive coverage for the root the plan scans.
 *
 * Every planned entry is looked up by name in one directory. The plugin derived that directory
 * from the settings document, which is the profile's patch file, so an export archived that one
 * file and dropped Session logs, attachments, Workspace storage, credentials, and identity —
 * all of which live under the Harness home. A Sessions export produced an archive containing
 * nothing but its manifest, and the code reported success.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeUserBackup } from '../src/archive.ts'
import type { BackupScope } from '../src/types.ts'

const roots: string[] = []

/** Create a throwaway directory removed after the test. */
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'plus-backup-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Collect the progress reports an export publishes, ignoring their content. */
const ignoreProgress = (): Promise<void> => Promise.resolve()

/** Zip entry names in an archive, read through the manifest's directory listing. */
async function entryNames(archivePath: string): Promise<string[]> {
  // yauzl is the reader the import path uses, so the assertion reflects what an import sees.
  const { open } = await import('yauzl')
  return await new Promise<string[]>((resolveNames, rejectNames) => {
    open(archivePath, { lazyEntries: true }, (error, zip) => {
      if (error !== null) { rejectNames(error); return }
      const names: string[] = []
      zip.on('entry', (entry: { fileName: string }) => { names.push(entry.fileName); zip.readEntry() })
      zip.on('end', () => { resolveNames(names) })
      zip.on('error', rejectNames)
      zip.readEntry()
    })
  })
}

/** Run one export into `target` and return the archive's entry names. */
async function exportNames(dshHome: string, scope: BackupScope): Promise<string[]> {
  const target = join(dshHome, 'export.zip')
  await writeUserBackup(dshHome, target, scope, 'cordis.patch.yml', new AbortController().signal, ignoreProgress)
  return await entryNames(target)
}

describe('writeUserBackup', () => {
  it('archives Session directories that live under the Harness home', async () => {
    const home = await temporaryRoot()
    await mkdir(join(home, 'sessions'), { recursive: true })
    await writeFile(join(home, 'sessions', 'one.jsonl'), '{}\n')
    await mkdir(join(home, 'storages'), { recursive: true })
    await writeFile(join(home, 'storages', 'workspace.json'), '{}\n')

    const names = await exportNames(home, 'sessions')

    expect(names).toContain('backup-manifest.json')
    expect(names).toContain('sessions/one.jsonl')
    expect(names).toContain('storages/workspace.json')
  })

  it('archives the Harness home configuration files, not only the patch file', async () => {
    const home = await temporaryRoot()
    await writeFile(join(home, 'cordis.patch.yml'), '- id: llm-pi-ai\n')
    await writeFile(join(home, '.credentials.yaml'), 'k: v\n')
    await writeFile(join(home, '.anonymous-user-id'), 'id\n')

    const names = await exportNames(home, 'configuration')

    expect(names).toContain('cordis.patch.yml')
    expect(names).toContain('.credentials.yaml')
    expect(names).toContain('.anonymous-user-id')
  })

  it('archives nothing but its manifest for a scope with no matching data', async () => {
    const home = await temporaryRoot()

    const names = await exportNames(home, 'sessions')

    // The manifest is the marker import requires; an absent scope contributes no other entry.
    expect(names).toEqual(['backup-manifest.json'])
  })

  it('reads planned entries from the root it was given', async () => {
    const home = await temporaryRoot()
    await writeFile(join(home, 'cordis.patch.yml'), 'from-home\n')
    await mkdir(join(home, 'profiles', 'dataops-web'), { recursive: true })
    // The regression: a root one level above the data yields a manifest-only archive.
    await writeFile(join(home, 'profiles', 'dataops-web', 'cordis.patch.yml'), 'from-profile\n')

    const target = join(home, 'export.zip')
    await writeUserBackup(home, target, 'configuration', 'cordis.patch.yml', new AbortController().signal, ignoreProgress)

    // Assert the archived bytes come from the scanned root, which is what makes the root matter.
    const names = await entryNames(target)
    expect(names).toContain('cordis.patch.yml')
    expect(names).not.toContain('profiles/dataops-web/cordis.patch.yml')
  })
})
