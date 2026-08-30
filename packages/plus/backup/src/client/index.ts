/**
 * Settings Backup section plugin, browser half. Archive bytes use exact Host
 * routes; preparation and restore state arrive as validated NDJSON progress
 * lines, outside the unary RPC carrier.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { BackupSection, type BackupSectionInjected } from './BackupSection.tsx'
import { createBackupSectionStore } from './store.ts'
import type { BackupSectionProgress } from './types.ts'
import { en, zh, type SettingsBackupKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Backup section copy. */
    settingsBackup: SettingsBackupKey
  }
}

const NS = 'settingsBackup'
export const inject = ['slots', 'locale']

type BackupProgressStreamLine = {
  type: 'progress'
  progress: Exclude<BackupSectionProgress, { phase: 'upload' }>
} | {
  type: 'export-ready'
  downloadUrl: string
  entries: number
} | {
  type: 'import-complete'
  entries: number
} | {
  type: 'error'
  message: string
}

type BackupTerminalLine = Extract<BackupProgressStreamLine, { type: 'export-ready' | 'import-complete' }>

/** Resolve a Host logical path beneath the runtime-injected document base. */
function browserHostUrl(path: string): string {
  return new URL(path.replace(/^[/]/u, ''), document.baseURI).toString()
}

/** Parse one unknown JSON object at the backup progress HTTP boundary. */
function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid backup progress message')
  }
  return value as Record<string, unknown>
}

/** Parse one finite non-negative byte or count field from the progress wire. */
function parseCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid backup progress count')
  }
  return value
}

/** Parse one Host-authored phase update from the exact-route stream. */
function parseHostProgress(value: unknown): Exclude<BackupSectionProgress, { phase: 'upload' }> {
  const record = parseRecord(value)
  if (record.phase === 'scan' || record.phase === 'validate' || record.phase === 'reload') {
    return { phase: record.phase }
  }
  if (record.phase === 'compress' || record.phase === 'restore') {
    const completedBytes = parseCount(record.completedBytes)
    const totalBytes = parseCount(record.totalBytes)
    if (completedBytes > totalBytes) throw new Error('invalid backup progress byte range')
    return { phase: record.phase, completedBytes, totalBytes }
  }
  throw new Error('unknown backup progress phase')
}

/** Parse one complete NDJSON line; this is the progress protocol's sole browser parser. */
function parseProgressLine(line: string): BackupProgressStreamLine {
  const record = parseRecord(JSON.parse(line) as unknown)
  if (record.type === 'progress') return { type: 'progress', progress: parseHostProgress(record.progress) }
  if (record.type === 'export-ready') {
    if (typeof record.downloadUrl !== 'string' || record.downloadUrl === '') {
      throw new Error('invalid backup export download URL')
    }
    return { type: 'export-ready', downloadUrl: record.downloadUrl, entries: parseCount(record.entries) }
  }
  if (record.type === 'import-complete') {
    return { type: 'import-complete', entries: parseCount(record.entries) }
  }
  if (record.type === 'error' && typeof record.message === 'string') {
    return { type: 'error', message: record.message }
  }
  throw new Error('unknown backup progress message')
}

/** Read and validate one exact-route NDJSON response until its terminal line. */
async function readProgressResponse(
  response: Response,
  report: (progress: BackupSectionProgress) => void,
): Promise<BackupTerminalLine> {
  if (!response.ok) throw new Error('backup operation failed: HTTP ' + String(response.status))
  if (response.body === null) throw new Error('backup progress response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let terminal: BackupTerminalLine | undefined
  let terminalError: string | undefined
  try {
    while (true) {
      const { done, value } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      const lines = pending.split(String.fromCharCode(10))
      if (done) pending = ''
      else pending = lines.pop() as string
      for (const line of lines) {
        if (line === '') continue
        const message = parseProgressLine(line)
        if (message.type === 'progress') report(message.progress)
        else if (message.type === 'error') terminalError = message.message
        else terminal = message
      }
      if (done) break
    }
  } finally {
    // terminal result只在stream reader释放后交给UI，reload不会中止已完成的fetch。
    reader.releaseLock()
  }
  if (terminalError !== undefined) throw new Error(terminalError)
  if (terminal === undefined) throw new Error('backup progress response ended without a result')
  return terminal
}

/** Parse the upload route's single-use token response. */
function parseUploadToken(text: string): string {
  const record = parseRecord(JSON.parse(text) as unknown)
  if (typeof record.token !== 'string' || record.token === '') throw new Error('invalid backup upload token')
  return record.token
}

/** Upload a File with browser-native byte progress and caller cancellation. */
function uploadArchive(
  file: File,
  report: (progress: BackupSectionProgress) => void,
  signal: AbortSignal,
): Promise<string> {
  report({ phase: 'upload', completedBytes: 0, totalBytes: file.size })
  return new Promise<string>((resolve, reject) => {
    const request = new XMLHttpRequest()
    const onSignalAbort = (): void => { request.abort() }
    const settle = (complete: () => void): void => {
      signal.removeEventListener('abort', onSignalAbort)
      complete()
    }
    request.open('POST', browserHostUrl('/api/backup.upload'))
    request.upload.onprogress = (event) => {
      report({ phase: 'upload', completedBytes: event.loaded, totalBytes: file.size })
    }
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        settle(() => { reject(new Error('backup upload failed: HTTP ' + String(request.status))) })
        return
      }
      try {
        const token = parseUploadToken(request.responseText)
        settle(() => { resolve(token) })
      } catch (error: unknown) {
        settle(() => { reject(error instanceof Error ? error : new Error(String(error))) })
      }
    }
    request.onerror = () => { settle(() => { reject(new Error('backup upload failed')) }) }
    request.onabort = () => { settle(() => { reject(new DOMException('Backup upload aborted', 'AbortError')) }) }
    signal.addEventListener('abort', onSignalAbort, { once: true })
    request.send(file)
  })
}

/** Register the Backup settings section and its exact-route transport callbacks. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plus-backup: dictionaries')
  const store = createBackupSectionStore()
  let activeController: AbortController | null = null
  ctx.effect(() => () => { activeController?.abort() }, 'plus-backup: cancel active operation')

  const runAbortable = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController()
    activeController = controller
    try {
      return await run(controller.signal)
    } finally {
      if (activeController === controller) activeController = null
    }
  }

  const injected = (): BackupSectionInjected => ({
    exportArchive: report => runAbortable(async (signal) => {
      const terminal = await readProgressResponse(await fetch(browserHostUrl('/api/backup.export.prepare'), {
        method: 'POST',
        signal,
      }), report)
      if (terminal.type !== 'export-ready') throw new Error('backup export returned an import result')
      return {
        downloadUrl: browserHostUrl(terminal.downloadUrl),
        entries: terminal.entries,
      }
    }),
    importArchive: (file, report) => runAbortable(async (signal) => {
      const token = await uploadArchive(file, report, signal)
      const terminal = await readProgressResponse(await fetch(browserHostUrl(
        '/api/backup.import?token=' + encodeURIComponent(token),
      ), { method: 'POST', signal }), report)
      if (terminal.type !== 'import-complete') throw new Error('backup import returned an export result')
      return { entries: terminal.entries }
    }),
    cancelOperation: () => { activeController?.abort() },
    reloadPage: () => { window.location.reload() },
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'backup',
    order: 30,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    store,
    inject: injected,
  }, BackupSection))
}
