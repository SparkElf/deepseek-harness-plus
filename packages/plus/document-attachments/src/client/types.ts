/** Browser-only Document draft, limits, and presentation owner data. */

import type { AttachmentIdType } from '@deepseek-ai/dsh-attachment'
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

/** Durable Document metadata and preview references rendered by history cards. */
export interface DocumentCardData {
  readonly previewAttachmentId: AttachmentIdType
  readonly name: string
  readonly mediaType: string
  readonly bytes: number
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Render the current Document drafts beside other composer attachments.
     * A contribution receives the drafts and removal callback from the composer;
     * it replaces the prior single Document-draft registration. Without one,
     * Document drafts remain accepted but have no dedicated draft cards.
     */
    'conversation.input.attachments.documents': {
      kind: 'single'
      scope: 'session-maybe'
      owner: { documents: readonly DocumentDraft[]; onRemoveDocument: (id: DraftAttachmentId) => void }
    }
    /**
     * Render durable Document metadata in one Chat message's attachment area.
     * A contribution receives the message's card data and replaces the prior
     * single Document-card registration. Without one, Chat omits these cards.
     */
    'conversation.message.images.documents': {
      kind: 'single'
      scope: 'session'
      owner: { documents: readonly DocumentCardData[] }
    }
    /**
     * Render durable Document metadata in one Trajectory entry's attachment area.
     * A contribution receives the entry's card data and replaces the prior single
     * Document-card registration. Without one, Trajectory omits these cards.
     */
    'conversation.trajectory.images.documents': {
      kind: 'single'
      scope: 'session'
      owner: { documents: readonly DocumentCardData[] }
    }
  }
}
