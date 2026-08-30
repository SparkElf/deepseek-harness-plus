/**
 * Backup settings section: exact Host routes stream archive bytes and progress;
 * the slot store survives settings-driven component remounts.
 */

import { useRef } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import type {
  InjectFace, PropsLocale, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { BackupSectionStore } from './store.ts'
import type {
  BackupErrorKey, BackupOperation, BackupSectionProgress,
} from './types.ts'
import css from './BackupSection.module.css'

/** Registration-side business face for the two streamed backup operations. */
export interface BackupSectionInjected {
  /**
   * Prepare a fresh export while reporting real source-byte progress.
   * @param report - receives ordered progress updates.
   * @returns the single-use browser download URL and entry count.
   */
  exportArchive(
    report: (progress: BackupSectionProgress) => void,
  ): Promise<{ downloadUrl: string; entries: number }>

  /**
   * Upload and restore one picked archive while reporting transport and Host progress.
   * @param file - browser-selected backup archive.
   * @param report - receives ordered progress updates.
   * @returns the restored entry count.
   */
  importArchive(
    file: File,
    report: (progress: BackupSectionProgress) => void,
  ): Promise<{ entries: number }>

  /** Cancel the active operation while its current phase still permits cancellation. */
  cancelOperation(): void

  /** Reload the browser so it fetches restored session and workspace baselines. */
  reloadPage(): void
}

/** Full component props. */
export type BackupSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settingsBackup'>
  & PropsStore<BackupSectionStore>
  & InjectFace<BackupSectionInjected>

/** Prove exhaustive progress phase handling. */
function assertNever(value: never): never {
  throw new Error('unknown backup progress phase: ' + String(value))
}

/** Return the locale key naming the current phase. */
function progressTextKey(progress: BackupSectionProgress): 'exportScan' | 'exportCompress' | 'importUpload' | 'importValidate' | 'importRestore' | 'importReload' {
  switch (progress.phase) {
    case 'scan': return 'exportScan'
    case 'compress': return 'exportCompress'
    case 'upload': return 'importUpload'
    case 'validate': return 'importValidate'
    case 'restore': return 'importRestore'
    case 'reload': return 'importReload'
    default: return assertNever(progress)
  }
}

/** Derive a displayed integer percentage only for phases with stable byte totals. */
function progressPercent(progress: BackupSectionProgress): number | undefined {
  switch (progress.phase) {
    case 'scan':
    case 'validate':
    case 'reload':
      return undefined
    case 'compress':
    case 'upload':
    case 'restore':
      return progress.totalBytes === 0
        ? 100
        : Math.floor(progress.completedBytes * 100 / progress.totalBytes)
    default:
      return assertNever(progress)
  }
}

/** Return whether the current phase can still stop without interrupting committed restore mutation. */
function canCancel(progress: BackupSectionProgress): boolean {
  switch (progress.phase) {
    case 'scan':
    case 'compress':
    case 'upload':
    case 'validate':
      return true
    case 'restore':
    case 'reload':
      return false
    default:
      return assertNever(progress)
  }
}

/** Recognize the browser cancellation error returned by fetch and XHR. */
function isCancellation(caught: unknown): boolean {
  return caught instanceof Error && caught.name === 'AbortError'
}

/** Map one transport or archive rejection to product copy. */
function localize(caught: unknown, kind: BackupOperation['kind']): BackupErrorKey {
  const message = caught instanceof Error ? caught.message : String(caught)
  if (message.includes('missing backup-manifest.json')) return 'notBackup'
  if (message.includes('unsafe path')) return 'unsafe'
  return kind === 'export' ? 'exportFailed' : 'importFailed'
}

/**
 * The Backup section body.
 * @param props - runtime owner props, locale, store seat, and streamed operation callbacks.
 * @returns the section tree.
 */
export function BackupSection(props: BackupSectionProps): ReactNode {
  const { t, actions } = props
  const operation = props.useStore(state => state.operation)
  const status = props.useStore(state => state.status)
  const error = props.useStore(state => state.error)
  const cancelling = props.useStore(state => state.cancelling)
  const reloadRequired = status === 'imported'
  const fileRef = useRef<HTMLInputElement>(null)

  const runExport = async (): Promise<void> => {
    actions.begin({ kind: 'export', progress: { phase: 'scan' } })
    try {
      const { downloadUrl } = await props.exportArchive((progress) => {
        actions.progress({ kind: 'export', progress })
      })
      const anchor = document.createElement('a')
      anchor.href = downloadUrl
      anchor.download = 'deepseek-harness-backup.zip'
      anchor.click()
      actions.complete('exported')
    } catch (caught) {
      if (isCancellation(caught)) {
        actions.cancelled()
        return
      }
      actions.fail(localize(caught, 'export'))
    }
  }

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    actions.begin({
      kind: 'import',
      progress: { phase: 'upload', completedBytes: 0, totalBytes: file.size },
    })
    void (async () => {
      try {
        await props.importArchive(file, (progress) => {
          actions.progress({ kind: 'import', progress })
        })
        actions.complete('imported')
      } catch (caught) {
        if (isCancellation(caught)) {
          actions.cancelled()
          return
        }
        actions.fail(localize(caught, 'import'))
      }
    })()
  }

  const percent = operation === null ? undefined : progressPercent(operation.progress)
  const progressText = operation === null
    ? ''
    : t(progressTextKey(operation.progress)) + (percent === undefined ? '' : ' ' + String(percent) + '%')

  return (
    <section className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.desc}>{t('desc')}</p>
      <div className={css.actions}>
        <button
          type="button"
          className={css.button}
          disabled={operation !== null || reloadRequired}
          onClick={() => { void runExport() }}
        >
          {operation?.kind === 'export' ? t('busyExport') : t('exportButton')}
        </button>
        <button
          type="button"
          className={css.button}
          disabled={operation !== null || reloadRequired}
          onClick={() => { fileRef.current?.click() }}
        >
          {operation?.kind === 'import' ? t('busyImport') : t('importButton')}
        </button>
        {operation !== null && canCancel(operation.progress) ? (
          <button
            type="button"
            className={css.button}
            disabled={cancelling}
            onClick={() => {
              actions.requestCancel()
              props.cancelOperation()
            }}
          >
            {t(cancelling ? 'cancellingButton' : 'cancelButton')}
          </button>
        ) : null}
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          className={css.fileInput}
          onChange={onPick}
        />
      </div>
      {operation !== null ? (
        <div className={css.progress} role="status" aria-live="polite">
          <p className={css.progressLabel}>{progressText}</p>
          {percent === undefined ? (
            <progress
              className={css.progressTrack}
              aria-label={t(operation.kind === 'export' ? 'exportProgressLabel' : 'importProgressLabel')}
              aria-valuetext={progressText}
            />
          ) : (
            <progress
              className={css.progressTrack}
              max={100}
              value={percent}
              aria-label={t(operation.kind === 'export' ? 'exportProgressLabel' : 'importProgressLabel')}
              aria-valuetext={progressText}
            />
          )}
          <p className={css.progressDetail}>{t('progressDetail')}</p>
        </div>
      ) : null}
      {status !== null ? <p className={css.status} role="status">{t(status)}</p> : null}
      {reloadRequired ? (
        <button type="button" className={css.button} onClick={() => { props.reloadPage() }}>
          {t('reloadButton')}
        </button>
      ) : null}
      {error !== null ? <p className={css.error} role="alert">{t(error)}</p> : null}
      <p className={css.warning}>{t('warning')}</p>
    </section>
  )
}
