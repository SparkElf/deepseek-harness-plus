/** Browser-only Document draft, limits, and presentation owner data. */

import type { DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Browser-owned Document draft before Host admission. */
export interface DocumentDraft {
  readonly kind: 'document'
  readonly id: DraftAttachmentId
  readonly file: File
}

/** Host-projected Document admission limits consumed by browser intake. */
export interface DocumentLimits {
  readonly maxDocumentBytes: number
  readonly maxDocumentsPerMessage: number
  readonly maxMessageDocumentBytes: number
  readonly mediaTypes: readonly string[]
}

/** Plain durable Document metadata rendered by history cards. */
interface DocumentCardData {
  readonly name: string
  readonly mediaType: string
  readonly bytes: number
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'conversation.input.attachments.documents': {
      kind: 'single'
      scope: 'session-maybe'
      owner: { documents: readonly DocumentDraft[]; onRemoveDocument: (id: DraftAttachmentId) => void }
    }
    'conversation.message.images.documents': {
      kind: 'single'
      scope: 'session'
      owner: { documents: readonly DocumentCardData[] }
    }
    'conversation.trajectory.images.documents': {
      kind: 'single'
      scope: 'session'
      owner: { documents: readonly DocumentCardData[] }
    }
  }
}
