/**
 * Backup settings section: export the user settings and data as one zip
 * archive (browser download) and import a zip archive back, with localized
 * status, busy, and failure copy. All live facts are component-private.
 */

import { useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './BackupSection.module.css'

/** Registration-side business face: the two Host backup operations. */
export interface BackupSectionInjected {
  /** Export the harness home archive; the component triggers the download. */
  exportArchive(): Promise<{ archiveBase64: string; entries: number }>
  /** Validate and restore one base64 archive over the harness home. */
  importArchive(archiveBase64: string): Promise<{ entries: number }>
}

/** Full component props. */
export type BackupSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settingsBackup'>
  & InjectFace<BackupSectionInjected>

/** In-flight operation, or idle. */
type Busy = 'export' | 'import' | null

/** Local timestamp for the downloaded archive file name. */
function downloadStamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 19)
}

/** Decode base64 into bytes for the download blob. */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0))
}

/** Encode a picked file as base64 for the import wire payload. */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

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
      const { archiveBase64 } = await props.exportArchive()
      const url = URL.createObjectURL(new Blob([base64ToBytes(archiveBase64)], { type: 'application/zip' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'deepseek-harness-backup-' + downloadStamp() + '.zip'
      anchor.click()
      URL.revokeObjectURL(url)
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
        await props.importArchive(await fileToBase64(file))
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
