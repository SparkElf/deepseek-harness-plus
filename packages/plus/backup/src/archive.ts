/**
 * User data backup core for the web settings Backup section. Export scans one
 * stable file plan, reads and compresses bounded chunks, and publishes source-
 * byte progress. Import validates before mutation, then writes bounded chunks
 * while publishing restored-byte progress.
 */

import { strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Transform } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { open as openZipFile, type Entry, type ZipFile } from 'yauzl'
import type { BackupProgressReporter } from './protocol.ts'
import type { BackupScope } from './types.ts'

/** Manifest entry at the archive root; import validation uses it as the marker. */
const BACKUP_MANIFEST_ENTRY = 'backup-manifest.json'

/** Optional configuration files stored beside the active Settings document. */
const CONFIGURATION_FILES = ['.credentials.yaml', '.env', '.anonymous-user-id'] as const

/** Durable Session data that must move together to preserve history and grouping. */
const SESSION_DIRECTORIES = ['sessions', 'attachments', 'storages'] as const

/** File read and restore write size. */
const BACKUP_CHUNK_BYTES = 64 * 1024

const EMPTY_BYTES = new Uint8Array(0)

type WaitForOutput = () => Promise<void>

type PlannedBackupEntry = {
  kind: 'directory'
  relativePath: string
} | {
  kind: 'file'
  relativePath: string
  size: number
}

interface BackupPlan {
  entries: PlannedBackupEntry[]
  manifest: Uint8Array
  totalBytes: number
}

interface BackupManifest {
  app: 'deepseek-harness'
  kind: 'user-data-backup'
  version: 2
  scope: BackupScope
  settingsFile: string
  exportedAt: string
}

/**
 * Add one directory's portable entries to a stable export plan.
 * @param rootPath - backup root directory.
 * @param relativePath - current slash-separated path relative to the root.
 * @param entries - plan entries under construction.
 * @param signal - caller or response cancellation.
 * @returns the summed regular-file bytes below this directory.
 */
async function planDirectory(
  rootPath: string,
  relativePath: string,
  entries: PlannedBackupEntry[],
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted()
  const children = await readdir(join(rootPath, relativePath), { withFileTypes: true })
  let bytes = 0
  for (const child of children) {
    signal.throwIfAborted()
    const entryRelative = relativePath === '' ? child.name : relativePath + '/' + child.name
    if (child.isDirectory()) {
      entries.push({ kind: 'directory', relativePath: entryRelative })
      bytes += await planDirectory(rootPath, entryRelative, entries, signal)
    } else if (child.isFile()) {
      const { size } = await stat(join(rootPath, entryRelative))
      entries.push({ kind: 'file', relativePath: entryRelative, size })
      bytes += size
    }
  }
  return bytes
}

/**
 * Build the stable file list and source-byte total used by one export.
 * @param dshHome - harness user data directory.
 * @param scope - selected user-data subset.
 * @param settingsFile - active Settings document basename.
 * @param signal - caller or response cancellation.
 * @returns the planned entries, manifest bytes, and measurable byte total.
 */
async function planUserBackup(
  dshHome: string,
  scope: BackupScope,
  settingsFile: string,
  signal: AbortSignal,
): Promise<BackupPlan> {
  const manifestRecord: BackupManifest = {
    app: 'deepseek-harness',
    kind: 'user-data-backup',
    version: 2,
    scope,
    settingsFile,
    exportedAt: new Date().toISOString(),
  }
  const manifest = strToU8(JSON.stringify(manifestRecord, null, 2) + String.fromCharCode(10))
  const entries: PlannedBackupEntry[] = []
  const topLevel = new Map(
    (await readdir(dshHome, { withFileTypes: true })).map(entry => [entry.name, entry]),
  )
  const names = [
    ...(scope === 'all' || scope === 'configuration'
      ? [settingsFile, ...CONFIGURATION_FILES]
      : []),
    ...(scope === 'all' || scope === 'sessions' ? SESSION_DIRECTORIES : []),
  ]
  let fileBytes = 0
  for (const name of new Set(names)) {
    signal.throwIfAborted()
    const entry = topLevel.get(name)
    if (entry?.isDirectory()) {
      entries.push({ kind: 'directory', relativePath: name })
      fileBytes += await planDirectory(dshHome, name, entries, signal)
    } else if (entry?.isFile()) {
      const { size } = await stat(join(dshHome, name))
      entries.push({ kind: 'file', relativePath: name, size })
      fileBytes += size
    }
  }
  return { entries, manifest, totalBytes: fileBytes + manifest.length }
}

/**
 * Add one planned file without retaining its complete contents.
 * @param zip - streaming archive receiving the file.
 * @param rootPath - backup root directory.
 * @param entry - planned file and scan-time size.
 * @param waitForOutput - waits for archive output backpressure or failure.
 * @param signal - caller or response cancellation.
 * @param onBytes - publishes each source chunk after archive output accepts it.
 * @returns when the planned file bytes have reached the archive output.
 */
async function addFileToZip(
  zip: Zip,
  rootPath: string,
  entry: Extract<PlannedBackupEntry, { kind: 'file' }>,
  waitForOutput: WaitForOutput,
  signal: AbortSignal,
  onBytes: (bytes: number) => Promise<void>,
): Promise<void> {
  const archiveFile = new ZipDeflate(entry.relativePath)
  zip.add(archiveFile)
  if (entry.size === 0) {
    archiveFile.push(EMPTY_BYTES, true)
    await waitForOutput()
    return
  }
  const source = createReadStream(join(rootPath, entry.relativePath), {
    end: entry.size - 1,
    highWaterMark: BACKUP_CHUNK_BYTES,
    signal,
  })
  let readBytes = 0
  for await (const chunk of source as AsyncIterable<Buffer>) {
    signal.throwIfAborted()
    archiveFile.push(chunk)
    await waitForOutput()
    readBytes += chunk.length
    await onBytes(chunk.length)
  }
  if (readBytes !== entry.size) throw new Error('backup source changed while reading: ' + entry.relativePath)
  archiveFile.push(EMPTY_BYTES, true)
  await waitForOutput()
}

/**
 * Pack the harness home's user configuration and data into a zip archive,
 * publishing scan and source-byte compression progress. A failed export removes
 * its partial archive.
 * @param dshHome - harness user data directory (settings.yaml parent).
 * @param targetPath - absolute file path the archive is written to.
 * @param scope - selected user-data subset.
 * @param settingsFile - active Settings document basename.
 * @param signal - caller or response cancellation.
 * @param report - ordered progress writer.
 * @returns the number of zip entries including the manifest marker.
 */
export async function writeUserBackup(
  dshHome: string,
  targetPath: string,
  scope: BackupScope,
  settingsFile: string,
  signal: AbortSignal,
  report: BackupProgressReporter,
): Promise<{ entries: number }> {
  await report({ phase: 'scan' })
  const plan = await planUserBackup(dshHome, scope, settingsFile, signal)
  let completedBytes = 0
  let lastPercent = -1
  const reportCompression = async (): Promise<void> => {
    const percent = Math.floor(completedBytes * 100 / plan.totalBytes)
    if (percent === lastPercent) return
    lastPercent = percent
    await report({ phase: 'compress', completedBytes, totalBytes: plan.totalBytes })
  }
  await reportCompression()

  let outputError: Error | undefined
  const output = createWriteStream(targetPath, { flags: 'w', signal })
  const outputSettled = finished(output).catch((error: unknown) => {
    outputError = error instanceof Error ? error : new Error(String(error))
  })
  let pendingDrain: Promise<unknown[]> | undefined
  output.on('error', (error: Error) => { outputError = error })

  const zip = new Zip((error, data, final) => {
    if (error !== null) {
      outputError = error
      output.destroy(error)
      return
    }
    if (outputError !== undefined) return
    if (data.length > 0 && !output.write(data)) pendingDrain = once(output, 'drain')
    if (final) output.end()
  })
  const waitForOutput = async (): Promise<void> => {
    const drain = pendingDrain
    pendingDrain = undefined
    if (drain !== undefined) await drain
    if (outputError !== undefined) throw outputError
  }

  let complete = false
  try {
    for (const entry of plan.entries) {
      signal.throwIfAborted()
      if (entry.kind === 'directory') {
        const directory = new ZipPassThrough(entry.relativePath + '/')
        zip.add(directory)
        directory.push(EMPTY_BYTES, true)
        await waitForOutput()
      } else {
        await addFileToZip(zip, dshHome, entry, waitForOutput, signal, async (bytes) => {
          completedBytes += bytes
          await reportCompression()
        })
      }
    }
    const manifest = new ZipDeflate(BACKUP_MANIFEST_ENTRY)
    zip.add(manifest)
    manifest.push(plan.manifest, true)
    await waitForOutput()
    completedBytes += plan.manifest.length
    await reportCompression()
    zip.end()
    await outputSettled
    if (outputError !== undefined) throw outputError
    complete = true
    return { entries: plan.entries.length + 1 }
  } finally {
    if (!complete) {
      zip.terminate()
      output.destroy()
      await outputSettled
      await rm(targetPath, { force: true })
    }
  }
}

/** One validated archive entry staged outside the harness home. */
type ValidatedBackupEntry = {
  kind: 'directory'
  relativePath: string
} | {
  kind: 'file'
  relativePath: string
  size: number
}

/** An archive fully validated and extracted to a temporary directory before user-data mutation. */
export interface ValidatedUserBackup {
  /** Temporary extraction root containing every validated regular file. */
  stagingRoot: string
  /** Validated portable entries in archive order. */
  entries: ValidatedBackupEntry[]
  /** Number of zip entries including the manifest marker. */
  count: number
  /** Total regular-file bytes restored into the harness home. */
  totalBytes: number
  /** User-data subset declared by the validated manifest. */
  scope: BackupScope
}

function isBackupScope(value: unknown): value is BackupScope {
  return value === 'all' || value === 'configuration' || value === 'sessions'
}

function requireBackupManifest(value: unknown, settingsFile: string): BackupManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Backup archive has an invalid backup-manifest.json')
  }
  const manifest = value as Record<string, unknown>
  if (manifest.app !== 'deepseek-harness'
    || manifest.kind !== 'user-data-backup'
    || manifest.version !== 2
    || !isBackupScope(manifest.scope)
    || typeof manifest.settingsFile !== 'string'
    || typeof manifest.exportedAt !== 'string') {
    throw new Error('Backup archive has an unsupported backup-manifest.json')
  }
  if ((manifest.scope === 'all' || manifest.scope === 'configuration')
    && manifest.settingsFile !== settingsFile) {
    throw new Error('Backup archive backup-manifest.json Settings filename does not match this DSH profile')
  }
  return manifest as unknown as BackupManifest
}

function scopeAllowsPath(scope: BackupScope, settingsFile: string, relativePath: string): boolean {
  const top = relativePath.split('/', 1)[0] as string
  const configuration = relativePath === settingsFile
    || CONFIGURATION_FILES.includes(relativePath as typeof CONFIGURATION_FILES[number])
  const sessions = SESSION_DIRECTORIES.includes(top as typeof SESSION_DIRECTORIES[number])
  return scope === 'all' ? configuration || sessions : scope === 'configuration' ? configuration : sessions
}

function openArchive(path: string): Promise<ZipFile> {
  return new Promise((resolveOpen, reject) => {
    openZipFile(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, zip) => {
      if (error !== null) reject(error)
      else resolveOpen(zip)
    })
  })
}

function nextArchiveEntry(zip: ZipFile): Promise<Entry | undefined> {
  return new Promise((resolveEntry, reject) => {
    const settle = (): void => {
      zip.off('entry', onEntry)
      zip.off('end', onEnd)
      zip.off('error', onError)
    }
    const onEntry = (entry: Entry): void => {
      settle()
      resolveEntry(entry)
    }
    const onEnd = (): void => {
      settle()
      resolveEntry(undefined)
    }
    const onError = (error: Error): void => {
      settle()
      reject(error)
    }
    zip.once('entry', onEntry)
    zip.once('end', onEnd)
    zip.once('error', onError)
    zip.readEntry()
  })
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolveStream, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) reject(error)
      else resolveStream(stream)
    })
  })
}

function requireSafeArchivePath(name: string): void {
  if (name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/u.test(name)) {
    throw new Error('Backup archive contains an unsafe path: ' + name)
  }
  const parts = name.split('/')
  for (const [index, part] of parts.entries()) {
    if (part === '..' || part === '.') throw new Error('Backup archive contains an unsafe path: ' + name)
    if (part === '' && index < parts.length - 1) throw new Error('Backup archive contains an unsafe path: ' + name)
  }
}

/**
 * Validate and extract one staged zip without retaining archive or entry bodies in memory.
 * @param archivePath - disk-staged raw upload.
 * @param stagingRoot - temporary extraction root outside the harness home.
 * @param maxExpandedBytes - aggregate expanded-byte limit shared with upload admission.
 * @param settingsFile - active Settings document basename used to validate configuration archives.
 * @param signal - response cancellation honored until DSH-home mutation begins.
 * @returns the validated staged entry plan.
 */
export async function validateUserBackup(
  archivePath: string,
  stagingRoot: string,
  maxExpandedBytes: number,
  settingsFile: string,
  signal: AbortSignal,
): Promise<ValidatedUserBackup> {
  const zip = await openArchive(archivePath)
  const entries: ValidatedBackupEntry[] = []
  const names = new Set<string>()
  let manifestSeen = false
  let expandedBytes = 0
  let totalBytes = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const entry = await nextArchiveEntry(zip)
      if (entry === undefined) break
      const name = entry.fileName
      requireSafeArchivePath(name)
      if (names.has(name)) throw new Error('Backup archive contains a duplicate path: ' + name)
      names.add(name)
      const directory = name.endsWith('/')
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
        || expandedBytes + entry.uncompressedSize > maxExpandedBytes) {
        throw new Error('Backup archive expanded data exceeds the configured limit')
      }
      expandedBytes += entry.uncompressedSize
      if (directory) {
        await mkdir(join(stagingRoot, name), { recursive: true })
        entries.push({ kind: 'directory', relativePath: name })
        continue
      }
      const target = join(stagingRoot, name)
      await mkdir(dirname(target), { recursive: true })
      const source = await openEntryStream(zip, entry)
      let written = 0
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          written += chunk.length
          callback(written > entry.uncompressedSize ? new Error('Backup archive entry exceeded its declared size') : null, chunk)
        },
      })
      await pipeline(source, limiter, createWriteStream(target, { flags: 'wx' }), { signal })
      if (written !== entry.uncompressedSize) throw new Error('Backup archive entry size mismatch: ' + name)
      if (name === BACKUP_MANIFEST_ENTRY) manifestSeen = true
      else totalBytes += written
      entries.push({ kind: 'file', relativePath: name, size: written })
    }
  } finally {
    zip.close()
  }
  if (!manifestSeen) {
    throw new Error('Not a DeepSeek Harness user data backup: missing ' + BACKUP_MANIFEST_ENTRY)
  }
  const manifest = requireBackupManifest(
    JSON.parse(await readFile(join(stagingRoot, BACKUP_MANIFEST_ENTRY), 'utf8')) as unknown,
    settingsFile,
  )
  for (const entry of entries) {
    if (entry.relativePath === BACKUP_MANIFEST_ENTRY) continue
    if (!scopeAllowsPath(manifest.scope, settingsFile, entry.relativePath)) {
      throw new Error(`Backup archive contains an unsafe path for its ${manifest.scope} scope: ${entry.relativePath}`)
    }
  }
  return { stagingRoot, entries, count: entries.length, totalBytes, scope: manifest.scope }
}

/**
 * Write a validated staged archive over the harness home while publishing restored bytes.
 * Once file mutation begins the operation completes rather than honoring a late response
 * cancellation, so user data is not left half-written by closing a page.
 * @param validated - validateUserBackup result.
 * @param dshHome - harness user data directory.
 * @param report - ordered progress writer; a disconnected response may ignore updates.
 * @returns the restored entry count.
 */
export async function restoreUserBackup(
  validated: ValidatedUserBackup,
  dshHome: string,
  report: BackupProgressReporter,
): Promise<{ entries: number }> {
  let completedBytes = 0
  let lastPercent = -1
  const reportRestore = async (): Promise<void> => {
    const percent = validated.totalBytes === 0 ? 100 : Math.floor(completedBytes * 100 / validated.totalBytes)
    if (percent === lastPercent) return
    lastPercent = percent
    await report({ phase: 'restore', completedBytes, totalBytes: validated.totalBytes })
  }
  await reportRestore()
  for (const entry of validated.entries) {
    if (entry.relativePath === BACKUP_MANIFEST_ENTRY) continue
    const target = join(dshHome, entry.relativePath)
    if (entry.kind === 'directory') {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        completedBytes += chunk.length
        void reportRestore().then(
          () => { callback(null, chunk) },
          (error: unknown) => { callback(error instanceof Error ? error : new Error(String(error))) },
        )
      },
    })
    await pipeline(
      createReadStream(join(validated.stagingRoot, entry.relativePath), { highWaterMark: BACKUP_CHUNK_BYTES }),
      progress,
      createWriteStream(target, { flags: 'w' }),
    )
  }
  await reportRestore()
  return { entries: validated.count }
}
