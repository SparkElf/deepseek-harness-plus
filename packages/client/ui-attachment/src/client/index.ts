/** Browser attachment plugin: composer picker/rail and historical image presentation. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ComposerAttachment, ComposerDocumentAttachment, DraftAttachmentId,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AttachmentPicker } from './AttachmentPicker.tsx'
import type { AttachmentPickerInjected } from './AttachmentPicker.tsx'
import { ComposerAttachments } from './ComposerAttachments.tsx'
import { MessageImages } from './MessageImages.tsx'

interface DraftAttachmentRegistry {
  createDraftImages(files: readonly File[]): readonly ComposerAttachment[]
  createDraftDocuments(files: readonly File[]): readonly ComposerDocumentAttachment[]
  draftImages(ids: readonly DraftAttachmentId[]): readonly ComposerAttachment[]
  draftDocuments(ids: readonly DraftAttachmentId[]): readonly ComposerDocumentAttachment[]
  releaseDraftAttachment(id: DraftAttachmentId): void
}

/** Slot registry plus the conversation draft registry used by the picker. */
export const inject = ['slots', 'conversation']

/** Resolve the concrete draft-only attachment verbs without a runtime package import. */
function drafts(ctx: ClientContext): DraftAttachmentRegistry {
  const conversation = ctx.get('conversation') as unknown as DraftAttachmentRegistry | undefined
  if (conversation === undefined) throw new Error('ui-attachment: conversation service unavailable')
  return conversation
}

/** Register attachment presentation and the composer tool-row file picker. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.attachments', () => ctx.slots.register({
    name: 'conversation.input.attachments',
    locale: 'conversation',
  }, ComposerAttachments))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'attachment-picker',
    order: 10,
    locale: 'conversation',
    inject: (): AttachmentPickerInjected => ({
      draftStats: (ids) => {
        const registry = drafts(ctx)
        const images = registry.draftImages(ids)
        const documents = registry.draftDocuments(ids)
        return {
          images: {
            count: images.length,
            bytes: images.reduce((sum, attachment) => sum + attachment.file.size, 0),
          },
          documents: {
            count: documents.length,
            bytes: documents.reduce((sum, attachment) => sum + attachment.file.size, 0),
          },
        }
      },
      createDrafts: (files) => {
        const registry = drafts(ctx)
        const imageInputs: Array<{ readonly index: number; readonly file: File }> = []
        const documentInputs: Array<{ readonly index: number; readonly file: File }> = []
        files.forEach((file, index) => {
          if (file.type.startsWith('image/')) imageInputs.push({ index, file })
          else documentInputs.push({ index, file })
        })
        const ids: Array<DraftAttachmentId | undefined> = Array(files.length).fill(undefined)
        const created: DraftAttachmentId[] = []
        try {
          const images = registry.createDraftImages(imageInputs.map(input => input.file))
          images.forEach((attachment, offset) => {
            const input = imageInputs[offset]
            if (input === undefined) return
            ids[input.index] = attachment.id
            created.push(attachment.id)
          })
          const documents = registry.createDraftDocuments(documentInputs.map(input => input.file))
          documents.forEach((attachment, offset) => {
            const input = documentInputs[offset]
            if (input === undefined) return
            ids[input.index] = attachment.id
            created.push(attachment.id)
          })
        } catch (error: unknown) {
          for (const id of created) registry.releaseDraftAttachment(id)
          throw error
        }
        if (ids.some(id => id === undefined)) {
          for (const id of created) registry.releaseDraftAttachment(id)
          throw new Error('ui-attachment: draft attachment registration lost an input')
        }
        return ids as DraftAttachmentId[]
      },
      releaseDrafts: (ids) => {
        const registry = drafts(ctx)
        for (const id of ids) registry.releaseDraftAttachment(id)
      },
    }),
  }, AttachmentPicker))

  ctx.slots.inject('conversation.message.images', () => ctx.slots.register({
    name: 'conversation.message.images',
    locale: 'conversation',
  }, MessageImages))
}
