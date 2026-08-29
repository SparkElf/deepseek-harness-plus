import { IconCloseFill14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './Documents.module.css'

type Props = PropsRuntime<'conversation.input.attachments.documents'> & PropsLocale<'documentAttachments'>
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
 * Render browser-owned Document drafts with remove controls.
 * @param props - nested composer slot owner data and locale translator.
 * @returns the draft rail, or null when empty.
 */
export function DraftDocuments({ documents, onRemoveDocument, t }: Props) {
  if (documents.length === 0) return null
  return <div className={css.list} aria-label={t('draft.group')}>
    {documents.map(document => <div className={css.card} key={document.id}>
      <span className={css.kind}>{fileKind(document.file.type, t)}</span>
      <span className={css.name} title={document.file.name}>{document.file.name}</span>
      <span className={css.size}>{formatBytes(document.file.size, t)}</span>
      <button type="button" className={css.remove} aria-label={t('draft.remove', { name: document.file.name })} title={t('draft.remove', { name: document.file.name })} onClick={() => { onRemoveDocument(document.id) }}>
        <IconCloseFill14 aria-hidden />
      </button>
    </div>)}
  </div>
}
