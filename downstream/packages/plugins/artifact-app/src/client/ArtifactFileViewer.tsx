/**
 * HTML file viewer for cockpit files.
 *
 * The descriptor only matches `/artifact-apps/**` HTML carrying the
 * `artifact-app` meta marker. Opening such a file creates or updates one draft
 * through the host and renders it exactly like a published cockpit, so the file
 * on disk is the draft.
 *
 * @module client/ArtifactFileViewer
 */

import { useEffect, useState } from 'react'
import { CockpitViewer } from './CockpitViewer.tsx'

/** Props the Better Sidebar file viewer passes. */
export interface ArtifactFileViewerProps {
  path: string
  title?: string
  content?: string
  largeFile?: { size: number }
}

/** Marker the file must carry for this viewer to claim it. */
export const ARTIFACT_FILE_MARKER = /<meta[^>]+name=["']artifact-app["'][^>]*>/iu

/**
 * Whether a file is a cockpit document.
 * @param path - workspace path.
 * @param head - the first bytes the viewer sniffed.
 */
export const isArtifactFile = (path: string, head: Uint8Array | string): boolean => {
  if (!/\/artifact-apps\/[^/]+\.html?$/iu.test(path)) return false
  const text = typeof head === 'string' ? head : new TextDecoder().decode(head)
  return ARTIFACT_FILE_MARKER.test(text)
}

/** Create/update the preview draft, then render it. */
export function ArtifactFileViewer({ path, content, largeFile }: ArtifactFileViewerProps) {
  const [artifactId, setArtifactId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (content === undefined) return undefined
    let alive = true
    setBusy(true)
    setError(null)
    void (async () => {
      try {
        const response = await fetch('/dsh-artifact-app/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ path, html: content }),
        })
        const payload = await response.json() as { artifactId?: string; error?: string }
        if (!response.ok || typeof payload.artifactId !== 'string') {
          throw new Error(payload.error ?? 'HTTP ' + String(response.status))
        }
        if (alive) setArtifactId(payload.artifactId)
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (alive) setBusy(false)
      }
    })()
    return () => { alive = false }
  }, [path, content, attempt])

  if (largeFile !== undefined) {
    return <div style={{ padding: 18, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6b7280)' }}>文件过大（{Math.round(largeFile.size / 1024)} KB），请缩小后再预览驾驶舱。</div>
  }
  if (error !== null) {
    return (
      <div role="alert" style={{ padding: 12, margin: 12, borderRadius: 8, background: '#fef2f2', color: '#b91c1c', fontSize: 12, display: 'grid', gap: 8 }}>
        <span style={{ whiteSpace: 'pre-wrap' }}>{error}</span>
        <button type="button" onClick={() => setAttempt((value) => value + 1)} style={{ justifySelf: 'start', border: '1px solid #fca5a5', background: 'transparent', color: '#b91c1c', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: 11 }}>重试</button>
      </div>
    )
  }
  if (busy || artifactId === null) {
    return <div style={{ padding: 18, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6b7280)' }}>正在生成驾驶舱预览…</div>
  }
  return <CockpitViewer artifactId={artifactId} />
}