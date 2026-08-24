/** Durable attachment storage seam (`ctx.attachments`). @module @deepseek-ai/dsh-attachment */

import { Context, Service } from '@deepseek-ai/cordis'
import { AttachmentError } from './error.ts'
import type {
  DocumentAttachmentLimits,
  FileAttachmentRef,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveFileAttachment,
  SaveImageAttachment,
  StoredFileAttachment,
  StoredImageAttachment,
} from './types.ts'

export { AttachmentId } from './brand.ts'
export { AttachmentError, isDocumentAdmissionError, isImageAdmissionError } from './error.ts'
export type { AttachmentErrorCode, DocumentAdmissionErrorCode, ImageAdmissionErrorCode } from './error.ts'
export { admitEncodedDocuments, admitEncodedImages } from './admission.ts'
export type {
  AttachmentId as AttachmentIdType,
  DocumentAttachmentLimits,
  DocumentAttachmentRef,
  DocumentMediaType,
  EncodedDocumentAttachment,
  EncodedImageAttachment,
  FileAttachmentRef,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageMediaType,
  ParsedDocumentRef,
  SaveDocumentAttachment,
  SaveFileAttachment,
  SaveImageAttachment,
  StoredDocumentAttachment,
  StoredFileAttachment,
  StoredImageAttachment,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    attachments: AttachmentStore
  }
}

/** Empty document capability inherited by legacy image-only attachment stores. */
const NO_DOCUMENT_CAPABILITY: DocumentAttachmentLimits = Object.freeze({
  maxDocumentBytes: 1,
  maxDocumentsPerMessage: 1,
  maxMessageDocumentBytes: 1,
  mediaTypes: Object.freeze([]),
})

/** Immutable binary attachment service. Implementations validate format-specific bytes before publishing references. */
export abstract class AttachmentStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }

  /** Deployment-resolved image policy used by authoritative and fast-path validation. */
  abstract readonly imageLimits: ImageAttachmentLimits

  /**
   * Deployment-resolved document policy used by authoritative and fast-path validation.
   * Legacy image-only stores inherit an empty media-type set and therefore reject document admission before persistence.
   */
  readonly documentLimits: DocumentAttachmentLimits = NO_DOCUMENT_CAPABILITY

  /**
   * Persist one format-agnostic immutable object after its caller has completed domain-specific admission.
   * Legacy image-only stores fail loud; document-capable stores override this primitive.
   * @param input - immutable bytes plus caller-owned media/display metadata.
   * @returns a durable content-addressed reference when the store supports generic files.
   */
  async saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    void input
    throw new AttachmentError('This attachment store does not support generic file persistence.', 'ATTACHMENT_WRITE_FAILED')
  }

  /**
   * Read one generic file object and verify that its bytes still match the content-addressed reference.
   * Legacy image-only stores fail loud; document-capable stores override this primitive.
   * @param ref - durable generic-file reference to resolve.
   * @param signal - optional cancellation observed before the unsupported-operation failure.
   * @returns the verified file bytes when the store supports generic files.
   */
  async readFile(ref: FileAttachmentRef, signal?: AbortSignal): Promise<StoredFileAttachment> {
    signal?.throwIfAborted()
    void ref
    throw new AttachmentError('This attachment store does not support generic file reads.', 'ATTACHMENT_READ_FAILED')
  }

  /**
   * Validate one image without persisting it.
   * Batch callers validate every member before saving any member.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns completion after the encoded raster has been fully decoded.
   */
  abstract validateImage(input: SaveImageAttachment): Promise<void>

  /**
   * Validate one ordered image batch before committing any member.
   * Validation failures start no writes; storage failures return no partial
   * references, although already published content-addressed objects may stay
   * unreachable until a future retention policy collects them.
   * @param inputs - encoded images in their owning message order.
   * @returns durable references in the exact input order.
   */
  async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]> {
    const { maxImagesPerMessage, maxMessageImageBytes, mediaTypes } = this.imageLimits
    if (inputs.length > maxImagesPerMessage) {
      throw new AttachmentError('Image batch exceeds the configured image-count limit.', 'TOO_MANY_IMAGES')
    }
    const totalBytes = inputs.reduce((sum, input) => sum + input.data.byteLength, 0)
    if (totalBytes > maxMessageImageBytes) {
      throw new AttachmentError('Image batch exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE')
    }
    for (const input of inputs) {
      if (!mediaTypes.includes(input.mediaType)) {
        throw new AttachmentError(`Image type ${input.mediaType} is not accepted by this deployment.`, 'UNSUPPORTED_IMAGE_TYPE')
      }
    }
    for (const input of inputs) await this.validateImage(input)

    const refs: ImageAttachmentRef[] = []
    for (const input of inputs) refs.push(await this.saveImage(input))
    return refs
  }

  /**
   * Validate and durably commit one image before its owning session event is appended.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns a durable content-addressed reference.
   */
  abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>

  /**
   * Read one image and verify that bytes still match the recorded reference.
   * @param ref - durable reference from the session log.
   * @param signal - optional cancellation for backend read and verification work.
   * @returns the verified bytes and canonical reference.
   * @throws the signal reason when aborted, or a storage error when verification fails.
   */
  abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
}

export default AttachmentStore
