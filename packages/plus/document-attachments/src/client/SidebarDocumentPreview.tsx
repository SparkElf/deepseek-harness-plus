import { useEffect, useMemo, useState } from 'react'
import type { AttachmentIdType } from '@deepseek-ai/dsh-attachment'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './Documents.module.css'

type PreviewState =
  | { phase: 'loading' }
  | { phase: 'ready'; markdown: string }
  | { phase: 'failed' }

/**
 * Render one session-authorized parsed document in a Better Sidebar tab.
 * @param props - preview identity, owning Session, loader, and localized labels.
 * @returns loading, failure, or parsed Markdown content.
 */
export function SidebarDocumentPreview({ attachmentId, sessionId, load, t }: {
  attachmentId: AttachmentIdType
  sessionId: SessionId
  load: (sessionId: SessionId, attachmentId: AttachmentIdType) => Promise<string>
  t: TranslateNS<'documentAttachments'>
}) {
  const [state, setState] = useState<PreviewState>({ phase: 'loading' })
  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('preview.copyCode'), copiedLabel: t('preview.copiedCode') },
    footnotes: t('preview.footnotes'),
  }), [t])

  useEffect(() => {
    let active = true
    setState({ phase: 'loading' })
    void load(sessionId, attachmentId).then((markdown) => {
      if (active) setState({ phase: 'ready', markdown })
    }).catch((error: unknown) => {
      console.error('document-attachments: sidebar preview failed', error)
      if (active) setState({ phase: 'failed' })
    })
    return () => { active = false }
  }, [attachmentId, load, sessionId])

  if (state.phase === 'failed') {
    return <div className={css.previewState} role="alert">{t('preview.failed')}</div>
  }
  if (state.phase === 'loading') {
    return <div className={css.previewState} role="status">{t('preview.loading')}</div>
  }
  if (state.markdown.trim() === '') {
    return <div className={css.previewState}>{t('preview.empty')}</div>
  }
  return <div className={css.previewContent}><MarkdownText text={state.markdown} labels={labels} /></div>
}
