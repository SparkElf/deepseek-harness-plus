/**
 * In-page document preview for the knowledge page.
 *
 * The knowledge page is a global main panel, and the host's right sidebar only
 * renders a session-bound preview while a conversation is the active panel. When
 * the host column is unavailable, this pane is the fallback the reader actually
 * sees: it reads the document through the same permission-checked `read` route the
 * preview pane uses and shows the text in place of the old "opened on the right"
 * notice.
 *
 * It deliberately does not replace the host viewer: when `openInSidebar` succeeds
 * the host tab still owns the document. This pane is the non-blank fallback for the
 * profile where that column cannot mount.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useEffect, useState } from 'react'
import { KB_API, kbApiPath, readKnowledgeJson } from '../api.ts'
import styles from './KnowledgeFilePreview.module.css'

/** Props for the fallback preview. */
export interface KnowledgeFilePreviewProps {
  /** View-relative document path. */
  path: string
  /** Copy resolver. */
  t: (key: string) => string
  /** Close the preview and return to the tree's previous surface. */
  onClose: () => void
}

/** What the read route answered. */
type ReadState =
  | { kind: 'loading' }
  | { kind: 'text'; content: string; truncated: boolean }
  | { kind: 'binary'; size: number }
  | { kind: 'failed'; error: string }

/** Human-readable size for the binary card. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB'
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB'
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB'
  return String(Math.round(bytes)) + ' B'
}

/** Save the document through the host download route (bytes arrive base64 over JSON). */
async function downloadDocument(path: string, name: string): Promise<void> {
  const response = await fetch(kbApiPath(KB_API.download), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
    cache: 'no-store',
  })
  const body = await readKnowledgeJson<{ contentBase64?: string; mimeType?: string; error?: string }>(response)
  if (!response.ok || typeof body.contentBase64 !== 'string') {
    throw new Error(typeof body.error === 'string' ? body.error : 'HTTP ' + String(response.status))
  }
  const binary = atob(body.contentBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const url = URL.createObjectURL(new Blob([bytes], { type: body.mimeType ?? 'application/octet-stream' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/**
 * Render one document read through the knowledge read route.
 *
 * @param props - the path, copy, and close command.
 * @returns The preview pane.
 */
export function KnowledgeFilePreview(props: KnowledgeFilePreviewProps) {
  const [state, setState] = useState<ReadState>({ kind: 'loading' })
  const name = props.path.slice(props.path.lastIndexOf('/') + 1)

  useEffect(() => {
    let alive = true
    setState({ kind: 'loading' })
    void (async () => {
      try {
        const response = await fetch(kbApiPath(KB_API.read), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: props.path }),
          cache: 'no-store',
        })
        const body = await readKnowledgeJson<Record<string, unknown>>(response)
        if (!response.ok || typeof body.error === 'string') {
          throw new Error(typeof body.error === 'string' ? body.error : 'HTTP ' + String(response.status))
        }
        if (!alive) return
        if (body.kind === 'text' && typeof body.content === 'string') {
          setState({ kind: 'text', content: body.content, truncated: body.truncated === true })
        } else if (body.kind === 'binary') {
          setState({ kind: 'binary', size: typeof body.size === 'number' ? body.size : 0 })
        } else {
          setState({ kind: 'failed', error: props.t('previewFailed') })
        }
      } catch (error) {
        if (!alive) return
        setState({ kind: 'failed', error: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => { alive = false }
  }, [props.path, props.t])

  return (
    <div className={styles.root} data-testid="kg-file-preview">
      <header className={styles.head}>
        <div className={styles.heading}>
          <h3 className={styles.title}>{name}</h3>
          <p className={styles.path}>{props.path}</p>
        </div>
        <button type="button" className={styles.close} onClick={props.onClose} aria-label={props.t('previewClose')}>
          ×
        </button>
      </header>
      <div className={styles.body}>
        {state.kind === 'loading' && <p className={styles.notice}>{props.t('previewLoading')}</p>}
        {state.kind === 'failed' && <p className={styles.error}>{props.t('previewFailed')} {state.error}</p>}
        {state.kind === 'binary' && (
          // A binary file has no in-page rendering to offer, so show a compact card instead of a
          // text-mode apology: the name, the size and one action.
          <div className={styles.binaryCard}>
            <span className={styles.binaryIcon} aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
              </svg>
            </span>
            <span className={styles.binaryMeta}>
              <strong className={styles.binaryName}>{name}</strong>
              <span className={styles.binarySize}>{formatBytes(state.size)}</span>
            </span>
            <button
              type="button"
              className={styles.binaryAction}
              onClick={() => { void downloadDocument(props.path, name).catch(() => undefined) }}
            >
              {props.t('previewDownload') || '下载'}
            </button>
          </div>
        )}
        {state.kind === 'text' && (
          <>
            {state.truncated && <p className={styles.notice}>{props.t('previewTruncated')}</p>}
            <pre className={styles.pre}>{state.content}</pre>
          </>
        )}
      </div>
    </div>
  )
}
