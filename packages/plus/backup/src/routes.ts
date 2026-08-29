/** Authenticated Host routes for streamed user-data Backup export and import. */

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { restoreUserBackup, validateUserBackup, writeUserBackup } from './archive.ts'
import type { BackupHostProgress, BackupProgressLine, BackupProgressReporter } from './protocol.ts'

const BACKUP_TOKEN_TTL_MS = 10 * 60_000

interface BackupDownloadToken {
  kind: 'download'
  path: string
  size: number
  expiresAt: number
}

interface BackupUploadToken {
  kind: 'upload'
  path: string
  expiresAt: number
}

type BackupToken = BackupDownloadToken | BackupUploadToken
type OwnedBackupToken = BackupToken & { expiryTimer: ReturnType<typeof setTimeout> }

/** Official Host context plus the one temporary Workspace operation supplied by the source patch. */
export type BackupHostContext = Context & {
  workspaceRegistry: Context['workspaceRegistry'] & {
    withStorageRestore<T>(restore: () => Promise<T>): Promise<T>
  }
}

/** Backup route resource policy. */
export interface BackupRouteConfig {
  maxUploadBytes: number
}

class BackupUploadTooLargeError extends Error {}

/** Own one-use Host temp-file tokens and delete every file when its ownership ends. */
class BackupTokenStore {
  private readonly entries = new Map<string, OwnedBackupToken>()

  mintDownload(path: string, size: number): string {
    this.sweep()
    return this.mint({ kind: 'download', path, size, expiresAt: Date.now() + BACKUP_TOKEN_TTL_MS })
  }

  mintUpload(path: string): string {
    this.sweep()
    return this.mint({ kind: 'upload', path, expiresAt: Date.now() + BACKUP_TOKEN_TTL_MS })
  }

  peekDownload(token: string): BackupDownloadToken | undefined {
    const entry = this.peek(token)
    return entry?.kind === 'download' ? entry : undefined
  }

  takeDownload(token: string): BackupDownloadToken | undefined {
    const entry = this.peekDownload(token)
    if (entry !== undefined) this.take(token)
    return entry
  }

  takeUpload(token: string): BackupUploadToken | undefined {
    const entry = this.peek(token)
    if (entry?.kind !== 'upload') return undefined
    this.take(token)
    return entry
  }

  async dispose(): Promise<void> {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.expiryTimer)
      await removeTempDirectory(entry.path, 'dispose')
    }
    this.entries.clear()
  }

  private mint(entry: BackupToken): string {
    const token = randomUUID()
    const owned: OwnedBackupToken = {
      ...entry,
      expiryTimer: setTimeout(() => {
        if (this.entries.get(token) !== owned) return
        this.entries.delete(token)
        void removeTempDirectory(owned.path, 'expired')
      }, BACKUP_TOKEN_TTL_MS),
    }
    this.entries.set(token, owned)
    return token
  }

  private peek(token: string): BackupToken | undefined {
    const entry = this.entries.get(token)
    if (entry === undefined) return undefined
    if (entry.expiresAt > Date.now()) return entry
    this.expire(token, entry)
    return undefined
  }

  private take(token: string): OwnedBackupToken | undefined {
    const entry = this.entries.get(token)
    if (entry === undefined) return undefined
    clearTimeout(entry.expiryTimer)
    this.entries.delete(token)
    return entry
  }

  private expire(token: string, entry: OwnedBackupToken): void {
    clearTimeout(entry.expiryTimer)
    this.entries.delete(token)
    void removeTempDirectory(entry.path, 'expired')
  }

  private sweep(): void {
    const now = Date.now()
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt > now) continue
      this.expire(token, entry)
    }
  }
}

/** Log temp cleanup failure with the original stack while withholding the path. */
async function removeTempDirectory(path: string, reason: string): Promise<void> {
  try {
    await rm(dirname(path), { recursive: true, force: true })
  } catch (error: unknown) {
    console.error('[plus-backup] temp cleanup failed', { reason }, error)
  }
}

/** Reject an unauthenticated route before reading any request body or query data. */
function registerProtectedRoute(
  ctx: Context,
  path: string,
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): void {
  // Backup访问完整DSH home；必须先复用Connection的Host/Origin/browser-auth判断，再进入业务parser。
  const route: WebRoute = {
    kind: 'exact',
    path,
    handler: async (request, response) => {
      const rejection = ctx.connection.requestRejection(request)
      if (rejection !== undefined) {
        response.writeHead(rejection)
        response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      await handler(request, response)
    },
  }
  ctx.effect(() => ctx.webServer.register(route), `plus-backup: ${path} route`)
}

function requireMethod(request: IncomingMessage, response: ServerResponse, methods: readonly string[]): boolean {
  if (request.method !== undefined && methods.includes(request.method)) return true
  response.writeHead(405, { allow: methods.join(', ') })
  response.end('method not allowed')
  return false
}

function tokenFromRequest(request: IncomingMessage): string | undefined {
  const token = new URL(request.url ?? '', 'http://localhost').searchParams.get('token')
  return token === null || token === '' ? undefined : token
}

async function writeProgressLine(response: ServerResponse, line: BackupProgressLine): Promise<void> {
  if (response.destroyed) throw new Error('backup progress response closed')
  if (!response.write(JSON.stringify(line) + String.fromCharCode(10))) await once(response, 'drain')
}

function beginProgressResponse(response: ServerResponse): AbortSignal {
  const controller = new AbortController()
  response.once('close', () => {
    if (!response.writableEnded) controller.abort()
  })
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.flushHeaders()
  return controller.signal
}

function publicOperationError(error: unknown, operation: 'export' | 'import'): string {
  if (error instanceof Error
    && (error.message.includes('missing backup-manifest.json') || error.message.includes('unsafe path'))) {
    return error.message
  }
  return 'backup ' + operation + ' failed'
}

/** Stream one upload to disk; both declared and observed bytes share this ingress limit owner. */
async function stageUpload(
  request: IncomingMessage,
  response: ServerResponse,
  tokens: BackupTokenStore,
  maxUploadBytes: number,
): Promise<void> {
  // upload不进入Connection JSON buffer；这里是唯一byte-limit owner并在mint token前完成disk write。
  if (!requireMethod(request, response, ['POST'])) return
  const declared = Number(request.headers['content-length'] ?? '0')
  if (Number.isFinite(declared) && declared > maxUploadBytes) {
    response.writeHead(413)
    response.end('backup upload too large')
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-backup-upload-'))
  const path = join(directory, 'upload.zip')
  let written = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length
      callback(written > maxUploadBytes ? new BackupUploadTooLargeError() : null, chunk)
    },
  })
  try {
    await pipeline(request, limiter, createWriteStream(path))
    if (response.destroyed) {
      await removeTempDirectory(path, 'upload response closed')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ token: tokens.mintUpload(path) }))
  } catch (error: unknown) {
    await removeTempDirectory(path, 'upload failed')
    if (request.destroyed || response.destroyed) return
    console.error('[plus-backup] upload failed', error)
    response.writeHead(error instanceof BackupUploadTooLargeError ? 413 : 500)
    response.end(error instanceof BackupUploadTooLargeError ? 'backup upload too large' : 'backup upload failed')
  }
}

async function prepareExport(
  request: IncomingMessage,
  response: ServerResponse,
  tokens: BackupTokenStore,
  dshHome: string,
): Promise<void> {
  if (!requireMethod(request, response, ['POST'])) return
  const signal = beginProgressResponse(response)
  const directory = await mkdtemp(join(tmpdir(), 'dsh-backup-export-'))
  const path = join(directory, 'backup.zip')
  let tokenMinted = false
  try {
    const { entries } = await writeUserBackup(dshHome, path, signal, progress =>
      writeProgressLine(response, { type: 'progress', progress }))
    const { size } = await stat(path)
    const token = tokens.mintDownload(path, size)
    tokenMinted = true
    await writeProgressLine(response, {
      type: 'export-ready',
      downloadUrl: '/api/backup.export?token=' + token,
      entries,
    })
    response.end()
  } catch (error: unknown) {
    if (!tokenMinted) await removeTempDirectory(path, 'export failed')
    if (signal.aborted || response.destroyed) return
    console.error('[plus-backup] export failed', error)
    await writeProgressLine(response, { type: 'error', message: publicOperationError(error, 'export') })
    response.end()
  }
}

async function downloadExport(
  request: IncomingMessage,
  response: ServerResponse,
  tokens: BackupTokenStore,
): Promise<void> {
  if (!requireMethod(request, response, ['GET', 'HEAD'])) return
  const token = tokenFromRequest(request)
  if (token === undefined) {
    response.writeHead(400)
    response.end('missing backup token')
    return
  }
  const entry = request.method === 'HEAD' ? tokens.peekDownload(token) : tokens.takeDownload(token)
  if (entry === undefined) {
    response.writeHead(404)
    response.end('unknown or expired backup token')
    return
  }
  response.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': 'attachment; filename="deepseek-harness-backup.zip"',
    'content-length': String(entry.size),
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  try {
    await pipeline(createReadStream(entry.path), response)
  } catch (error: unknown) {
    console.error('[plus-backup] download failed', error)
    if (!response.destroyed) response.destroy(error instanceof Error ? error : new Error(String(error)))
  } finally {
    await removeTempDirectory(entry.path, 'download settled')
  }
}

/** Validate before mutation, then complete restore even when the browser closes mid-write. */
async function importBackup(
  ctx: BackupHostContext,
  request: IncomingMessage,
  response: ServerResponse,
  tokens: BackupTokenStore,
  dshHome: string,
  maxExpandedBytes: number,
): Promise<void> {
  // cancel只在validation前生效；首次restore progress后必须完成file replacement与Workspace reopen。
  if (!requireMethod(request, response, ['POST'])) return
  const token = tokenFromRequest(request)
  if (token === undefined) {
    response.writeHead(400)
    response.end('missing backup upload token')
    return
  }
  const signal = beginProgressResponse(response)
  const staged = tokens.takeUpload(token)
  if (staged === undefined) {
    await writeProgressLine(response, { type: 'error', message: 'unknown or expired backup upload token' })
    response.end()
    return
  }
  const lifecycle = { restoreStarted: false }
  const report: BackupProgressReporter = async (progress: BackupHostProgress) => {
    if (progress.phase === 'restore') lifecycle.restoreStarted = true
    if (lifecycle.restoreStarted && response.destroyed) return
    try {
      await writeProgressLine(response, { type: 'progress', progress })
    } catch (error: unknown) {
      if (!lifecycle.restoreStarted) throw error
      console.error('[plus-backup] restore progress response failed', error)
    }
  }
  try {
    signal.throwIfAborted()
    await report({ phase: 'validate' })
    const validated = await validateUserBackup(
      staged.path,
      join(dirname(staged.path), 'validated'),
      maxExpandedBytes,
      signal,
    )
    signal.throwIfAborted()
    const { entries } = await ctx.workspaceRegistry.withStorageRestore(async () => {
      const restored = await restoreUserBackup(validated, dshHome, report)
      await report({ phase: 'reload' })
      return restored
    })
    if (response.destroyed) return
    await writeProgressLine(response, { type: 'import-complete', entries })
    response.end()
  } catch (error: unknown) {
    if (!lifecycle.restoreStarted && (signal.aborted || response.destroyed)) return
    console.error('[plus-backup] import failed', error)
    if (response.destroyed) return
    await writeProgressLine(response, { type: 'error', message: publicOperationError(error, 'import') })
    response.end()
  } finally {
    await removeTempDirectory(staged.path, 'import settled')
  }
}

/**
 * Register the complete authenticated Backup route set and its temp-file lifecycle.
 * @param ctx - Host services and the patched Workspace restore operation.
 * @param config - Upload resource policy.
 * @param dshHome - File-backed DSH home whose user data is archived.
 */
export function registerBackupRoutes(ctx: BackupHostContext, config: BackupRouteConfig, dshHome: string): void {
  const tokens = new BackupTokenStore()
  ctx.effect(() => () => tokens.dispose(), 'plus-backup: temp files')
  registerProtectedRoute(ctx, '/api/backup.upload', (request, response) =>
    stageUpload(request, response, tokens, config.maxUploadBytes))
  registerProtectedRoute(ctx, '/api/backup.export.prepare', (request, response) =>
    prepareExport(request, response, tokens, dshHome))
  registerProtectedRoute(ctx, '/api/backup.export', (request, response) =>
    downloadExport(request, response, tokens))
  registerProtectedRoute(ctx, '/api/backup.import', (request, response) =>
    importBackup(ctx, request, response, tokens, dshHome, config.maxUploadBytes))
}
