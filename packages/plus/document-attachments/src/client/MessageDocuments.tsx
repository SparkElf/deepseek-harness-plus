import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './Documents.module.css'

type Props = PropsRuntime<'conversation.message.images.documents'> & PropsLocale<'documentAttachments'>
type TrajectoryProps = PropsRuntime<'conversation.trajectory.images.documents'> & PropsLocale<'documentAttachments'>
function fileKind(mediaType: string, t: Props['t']): string {
  if (mediaType === 'application/pdf') return t('format.pdf')
  if (mediaType.includes('wordprocessingml')) return t('format.docx')
  if (mediaType.includes('presentationml')) return t('format.pptx')
  return t('format.xlsx')
}
function formatBytes(bytes: number, t: Props['t']): string {
  if (bytes >= 1024 * 1024) return t('format.mib', { value: (bytes / (1024 * 1024)).toFixed(1) })
  return t('format.kib', { value: Math.max(1, Math.ceil(bytes / 1024)) })
}
/**
 * Render durable Document cards in Chat history.
 * @param props - nested Chat attachment owner data and locale translator.
 * @returns the history card row, or null when empty.
 */
export function MessageDocuments({ documents, t }: Props) {
  return <DocumentCards documents={documents} label={t('history.group')} t={t} />
}

/**
 * Render durable Document cards in Trajectory history.
 * @param props - nested Trajectory attachment owner data and locale translator.
 * @returns the history card row, or null when empty.
 */
export function TrajectoryDocuments({ documents, t }: TrajectoryProps) {
  return <DocumentCards documents={documents} label={t('history.group')} t={t} />
}

function DocumentCards({ documents, label, t }: { documents: Props['documents']; label: string; t: Props['t'] }) {
  if (documents.length === 0) return null
  return <div className={css.history} aria-label={label}>
    {documents.map((document, index) => <div className={css.historyCard} key={`${document.name}:${index}`}>
      <span className={css.kind}>{fileKind(document.mediaType, t)}</span>
      <span className={css.name} title={document.name}>{document.name}</span>
      <span className={css.size}>{formatBytes(document.bytes, t)}</span>
    </div>)}
  </div>
}
