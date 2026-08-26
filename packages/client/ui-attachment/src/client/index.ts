/** Browser attachment plugin: composer picker/rail and historical image presentation. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ComposerAttachment, ComposerDocumentAttachment, DraftAttachmentId,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
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

/** Only the slot registry is a boot dependency; the picker resolves conversation lazily when used. */
export const inject = ['slots']

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
        const created: Array<{ readonly index: number; readonly id: DraftAttachmentId }> = []
        try {
          const images = registry.createDraftImages(imageInputs.map(input => input.file))
          images.forEach((attachment, offset) => {
            const input = imageInputs[offset]! // oxlint-disable-line typescript/no-non-null-assertion -- one result per input.
            created.push({ index: input.index, id: attachment.id })
          })
          const documents = registry.createDraftDocuments(documentInputs.map(input => input.file))
          documents.forEach((attachment, offset) => {
            const input = documentInputs[offset]! // oxlint-disable-line typescript/no-non-null-assertion -- one result per input.
            created.push({ index: input.index, id: attachment.id })
          })
        } catch (error: unknown) {
          ctx.logger.error('ui-attachment: mixed draft creation failed')
          ctx.logger.error(error)
          for (const attachment of created) registry.releaseDraftAttachment(attachment.id)
          throw error
        }
        return created.sort((left, right) => left.index - right.index).map(attachment => attachment.id)
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
