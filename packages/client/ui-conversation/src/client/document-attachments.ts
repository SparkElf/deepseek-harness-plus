/** Generic document additions to the browser composer contracts. */

import type { DraftAttachmentId } from './input/contract.ts'

/** Browser-owned document that has not crossed the durable Host boundary. */
export interface ComposerDocumentAttachment {
  kind: 'document'
  id: DraftAttachmentId
  file: File
}

declare module './contract/slots.ts' {
  interface ComposerAttachmentsOwnerProps {
    /** Browser-owned draft documents in input order. */
    documents: readonly ComposerDocumentAttachment[]
    /** Opaque mixed image/document ids in the exact composer order. */
    attachmentOrder: readonly DraftAttachmentId[]
    /** Add one document batch through the composer's validation path. */
    onAddDocuments: (files: readonly File[]) => void
    /** Remove one draft document through the conversation service. */
    onRemoveDocument: (id: DraftAttachmentId) => void
    /** Display-ready document limits for the drop invitation. */
    documentDropLimits?: { readonly count: number; readonly size: string } | undefined
  }

  interface ComposerBarInjected {
    /** Register supported documents in the browser draft registry. */
    addDocuments: ((files: readonly File[]) => string | null) | undefined
    /** Release one document from the browser draft registry and input state. */
    removeDocument: ((id: DraftAttachmentId) => void) | undefined
    /** Resolve ordered input ids to browser-owned draft documents. */
    draftDocuments: ((ids: readonly DraftAttachmentId[]) => readonly ComposerDocumentAttachment[]) | undefined
  }
}
