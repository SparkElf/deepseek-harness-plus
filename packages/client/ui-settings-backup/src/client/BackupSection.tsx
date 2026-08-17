/**
 * Backup settings section: export the user settings and data as one zip
 * archive (browser download streamed from the Host) and import such an
 * archive back (the file streams to the Host upload route; only a token
 * rides the RPC). All live facts are component-private.
 */

import { useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './BackupSection.module.css'

/** Registration-side business face: the two Host backup operations. */
export interface BackupSectionInjected {
  /** Mint a single-use download URL for a fresh export archive. */
  exportArchive(): Promise<{ downloadUrl: string; entries: number }>
  /** Stream one picked archive to the Host and restore it. */
  importArchive(file: File): Promise<{ entries: number }>
}

/** Full component props. */
export type BackupSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settingsBackup'>
  & InjectFace<BackupSectionInjected>

/** In-flight operation, or idle. */
type Busy = 'export' | 'import' | null

/**
 * The Backup section body.
 * @param props - the four shares: runtime owner props, locale, and inject face.
 * @returns the section tree.
 */
export function BackupSection(props: BackupSectionProps): ReactNode {
  const { t } = props
  const [busy, setBusy] = useState<Busy>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const localize = (caught: unknown): string => {
    const message = caught instanceof Error ? caught.message : String(caught)
    if (message.includes('missing backup-manifest.json')) return t('notBackup')
    if (message.includes('unsafe path')) return t('unsafe')
    return t('failed')
  }

  const runExport = async (): Promise<void> => {
    setBusy('export')
    setStatus(null)
    setError(null)
    try {
      const { downloadUrl } = await props.exportArchive()
      const anchor = document.createElement('a')
      anchor.href = downloadUrl
      anchor.download = 'deepseek-harness-backup.zip'
      anchor.click()
      setStatus(t('exported'))
    } catch (caught) {
      setError(localize(caught))
    } finally {
      setBusy(null)
    }
  }

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    void (async () => {
      setBusy('import')
      setStatus(null)
      setError(null)
      try {
        await props.importArchive(file)
        setStatus(t('imported'))
      } catch (caught) {
        setError(localize(caught))
      } finally {
        setBusy(null)
      }
    })()
  }

  return (
    <section className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.desc}>{t('desc')}</p>
      <div className={css.actions}>
        <button
          type="button"
          className={css.button}
          disabled={busy !== null}
          onClick={() => { void runExport() }}
        >
          {busy === 'export' ? t('busyExport') : t('exportButton')}
        </button>
        <button
          type="button"
          className={css.button}
          disabled={busy !== null}
          onClick={() => { fileRef.current?.click() }}
        >
          {busy === 'import' ? t('busyImport') : t('importButton')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          className={css.fileInput}
          onChange={onPick}
        />
      </div>
      {status !== null ? <p className={css.status} role="status">{status}</p> : null}
      {error !== null ? <p className={css.error} role="alert">{error}</p> : null}
      <p className={css.warning}>{t('warning')}</p>
    </section>
  )
}
