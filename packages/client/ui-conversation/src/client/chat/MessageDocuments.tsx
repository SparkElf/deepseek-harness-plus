import type { DocumentAttachmentRef } from '@deepseek-ai/dsh-attachment'
import css from './MessageDocuments.module.css'

/** One durable document block projected into transcript chrome. */
export interface MessageDocumentItem {
  readonly attachment: DocumentAttachmentRef
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

function typeLabel(mediaType: DocumentAttachmentRef['mediaType']): string {
  switch (mediaType) {
    case 'application/pdf': return 'PDF'
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return 'DOCX'
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation': return 'PPTX'
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return 'XLSX'
  }
}

/**
 * Display-only document cards for durable user/steering history.
 * Original bytes remain in the attachment store and generic UI exposes no
 * parser state, filesystem path, or opaque attachment id.
 */
export function MessageDocuments({ documents, label }: {
  documents: readonly MessageDocumentItem[]
  label: string
}) {
  if (documents.length === 0) return null
  return (
    <div className={css.list} role="group" aria-label={label}>
      {documents.map(({ attachment }) => (
        <div
          key={String(attachment.attachmentId)}
          className={css.card}
          data-message-document
          title={attachment.name}
        >
          <span className={css.type}>{typeLabel(attachment.mediaType)}</span>
          <span className={css.name}>{attachment.name}</span>
          <span className={css.detail}>{sizeLabel(attachment.bytes)}</span>
        </div>
      ))}
    </div>
  )
}
