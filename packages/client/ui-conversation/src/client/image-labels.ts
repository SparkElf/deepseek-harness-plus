/** Attachment error and limit copy owned by the conversation input flow. */

import type { DocumentAttachmentLimits, ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationKey } from './locales.ts'

/**
 * Byte count as user-facing megabytes (`10MB`, `2.5MB`).
 * @param bytes - the byte count.
 * @returns the rounded megabyte text.
 */
export function imageSizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${Number.isInteger(mb) ? String(mb) : mb.toFixed(1)}MB`
}

/**
 * Product copy for a host attachment rejection (the `attachment-error`
 * `details.reason`). User-solvable reasons name the limit and the way out;
 * reasons the user cannot act on fold into one send-failed line carrying the
 * reason code for a bug report.
 * @param t - the conversation-namespace translate.
 * @param reason - the wire `details.reason` code.
 * @param limits - projected image limits interpolated into image count/size copy, when known.
 * @param documentLimits - projected document limits interpolated into document count/size copy, when known.
 * @returns the banner text.
 */
export function attachmentErrorText(
  t: Translate<ConversationKey>,
  reason: string,
  limits?: ImageAttachmentLimits,
  documentLimits?: DocumentAttachmentLimits,
): string {
  switch (reason) {
    case 'DOCUMENT_PARSER_UNAVAILABLE':
    case 'DOCUMENT_PARSER_CONFIGURED_MISSING':
    case 'DOCUMENT_PARSER_AMBIGUOUS':
      return t('document.parserUnavailable')
    case 'DOCUMENT_PARSE_FAILED':
    case 'DOCUMENT_PARSE_INVALID_OUTPUT':
    case 'DOCUMENT_PARSE_TIMEOUT':
      return t('document.parseFailed')
    case 'DOCUMENT_PARSE_RESPONSE_TOO_LARGE':
    case 'DOCUMENT_PARSE_CONTEXT_TOO_LARGE':
      return t('document.parsedTooLarge')
    case 'INVALID_DOCUMENT':
    case 'DOCUMENT_TYPE_MISMATCH':
    case 'UNSUPPORTED_DOCUMENT_TYPE':
      return t('document.unsupportedType')
    case 'TOO_MANY_DOCUMENTS':
      if (documentLimits !== undefined) return t('document.tooMany', { count: documentLimits.maxDocumentsPerMessage })
      break
    case 'DOCUMENT_TOO_LARGE':
      if (documentLimits !== undefined) return t('document.fileTooLarge', { size: imageSizeText(documentLimits.maxDocumentBytes) })
      break
    case 'DOCUMENTS_TOO_LARGE':
      if (documentLimits !== undefined) return t('document.totalTooLarge', { size: imageSizeText(documentLimits.maxMessageDocumentBytes) })
      break
    case 'MODEL_DOES_NOT_SUPPORT_IMAGES': return t('image.modelUnsupported')
    case 'SUBAGENT_IMAGE_UNSUPPORTED': return t('image.subagentUnsupported')
    case 'IMAGE_TOO_MANY_PIXELS': return t('image.tooManyPixels')
    case 'IMAGE_DIMENSION_TOO_LARGE':
      if (limits !== undefined) return t('image.dimensionTooLarge', { size: limits.maxImageDimension })
      break
    // Undecodable bytes or a declared type its bytes contradict: solvable by
    // replacing or re-exporting the file, so it reads as a format problem.
    case 'INVALID_IMAGE':
    case 'IMAGE_TYPE_MISMATCH':
      return t('image.unsupportedType')
    case 'TOO_MANY_IMAGES':
      if (limits !== undefined) return t('image.tooMany', { count: limits.maxImagesPerMessage })
      break
    case 'IMAGE_TOO_LARGE':
      if (limits !== undefined) return t('image.fileTooLarge', { size: imageSizeText(limits.maxImageBytes) })
      break
    case 'IMAGES_TOO_LARGE':
      if (limits !== undefined) return t('image.totalTooLarge', { size: imageSizeText(limits.maxMessageImageBytes) })
      break
    default: break
  }
  return t('attachment.sendFailed', { reason })
}
