/** Wire-form admission of base64-encoded image and document uploads. @module @deepseek-ai/dsh-attachment/admission */

import { Buffer } from 'node:buffer'
import { AttachmentError } from './error.ts'
import type { AttachmentStore } from './index.ts'
import type {
  DocumentAttachmentRef,
  DocumentMediaType,
  EncodedDocumentAttachment,
  EncodedImageAttachment,
  ImageAttachmentRef,
  SaveFileAttachment,
  SaveImageAttachment,
} from './types.ts'

/** Decode one image upload payload while rejecting non-canonical base64 forms. */
function decodeImageBase64(data: string): Uint8Array {
  const decoded = Buffer.from(data, 'base64')
  if (data.length === 0 || decoded.toString('base64') !== data) {
    throw new AttachmentError('Image upload is not canonical base64.', 'INVALID_IMAGE_BASE64')
  }
  return new Uint8Array(decoded)
}

/** Decode one document upload payload while rejecting non-canonical base64 forms. */
function decodeDocumentBase64(data: string): Uint8Array {
  const decoded = Buffer.from(data, 'base64')
  if (data.length === 0 || decoded.toString('base64') !== data) {
    throw new AttachmentError('Document upload is not canonical base64.', 'INVALID_BASE64')
  }
  return new Uint8Array(decoded)
}

/** Store input for one decoded image upload. */
function imageSaveInput(image: EncodedImageAttachment): SaveImageAttachment {
  return {
    data: decodeImageBase64(image.data),
    mediaType: image.mediaType,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

const DOCUMENT_EXTENSIONS: Readonly<Record<DocumentMediaType, string>> = Object.freeze({
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
})

/** Strip browser-local paths/control characters while keeping a required display name. */
function documentDisplayName(value: string): string {
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)
  if (clean === '') throw new AttachmentError('Document name is empty after normalization.', 'INVALID_DOCUMENT')
  return clean
}

function hasZipSignature(data: Uint8Array): boolean {
  if (data.byteLength < 4) return false
  return data[0] === 0x50 && data[1] === 0x4b
    && ((data[2] === 0x03 && data[3] === 0x04)
      || (data[2] === 0x05 && data[3] === 0x06)
      || (data[2] === 0x07 && data[3] === 0x08))
}

function hasPdfSignature(data: Uint8Array): boolean {
  return data.byteLength >= 5
    && data[0] === 0x25
    && data[1] === 0x50
    && data[2] === 0x44
    && data[3] === 0x46
    && data[4] === 0x2d
}

function validateDocumentContainer(data: Uint8Array, mediaType: DocumentMediaType): void {
  const valid = mediaType === 'application/pdf' ? hasPdfSignature(data) : hasZipSignature(data)
  if (!valid) throw new AttachmentError('Document bytes do not match the required container signature.', 'INVALID_DOCUMENT')
}

interface DecodedDocument {
  readonly data: Uint8Array
  readonly mediaType: DocumentMediaType
  readonly name: string
}

function decodeDocument(document: EncodedDocumentAttachment, attachments: AttachmentStore): DecodedDocument {
  const limits = attachments.documentLimits
  if (!limits.mediaTypes.includes(document.mediaType)) {
    throw new AttachmentError(`Document type ${document.mediaType} is not accepted by this deployment.`, 'UNSUPPORTED_DOCUMENT_TYPE')
  }
  const name = documentDisplayName(document.name)
  if (!name.toLowerCase().endsWith(DOCUMENT_EXTENSIONS[document.mediaType])) {
    throw new AttachmentError('Document filename extension does not match the declared media type.', 'DOCUMENT_TYPE_MISMATCH')
  }
  const data = decodeDocumentBase64(document.data)
  if (data.byteLength > limits.maxDocumentBytes) {
    throw new AttachmentError('Document exceeds the configured byte limit.', 'DOCUMENT_TOO_LARGE')
  }
  validateDocumentContainer(data, document.mediaType)
  return { data, mediaType: document.mediaType, name }
}

/**
 * Admit one wire image batch: enforce canonical base64 on every member, then
 * delegate batch admission — count and aggregate-byte limits, media-type and
 * per-image validation, ordered commit — to {@link AttachmentStore.saveImages}.
 * The shared entry for every RPC endpoint accepting browser uploads.
 * @param attachments - the deployment attachment store owning batch policy.
 * @param images - base64-encoded uploads in caller order.
 * @returns durable references in the same order as `images`.
 * @throws AttachmentError on a non-canonical payload or a refused batch.
 */
export async function admitEncodedImages(
  attachments: AttachmentStore,
  images: readonly EncodedImageAttachment[],
): Promise<readonly ImageAttachmentRef[]> {
  return attachments.saveImages(images.map(imageSaveInput))
}

/**
 * Admit one wire document batch before any durable object is published.
 *
 * The whole batch is decoded and validated first: deployment count/byte
 * limits, canonical base64, required normalized filename, filename/media-type
 * agreement, and the minimum PDF/OOXML container signature. Office archives
 * are deliberately not parsed here; the external document parser owns content
 * validation in the stacked feature.
 * @param documents - base64-encoded supported documents in caller order.
 * @param attachments - deployment attachment store owning limits and durable bytes.
 * @returns immutable document references in caller order.
 */
export async function admitEncodedDocuments(
  documents: readonly EncodedDocumentAttachment[],
  attachments: AttachmentStore,
): Promise<readonly DocumentAttachmentRef[]> {
  const { maxDocumentsPerMessage, maxMessageDocumentBytes } = attachments.documentLimits
  if (documents.length > maxDocumentsPerMessage) {
    throw new AttachmentError('Document batch exceeds the configured document-count limit.', 'TOO_MANY_DOCUMENTS')
  }

  const decoded = documents.map(document => decodeDocument(document, attachments))
  const totalBytes = decoded.reduce((sum, document) => sum + document.data.byteLength, 0)
  if (totalBytes > maxMessageDocumentBytes) {
    throw new AttachmentError('Document batch exceeds the configured aggregate document-byte limit.', 'DOCUMENTS_TOO_LARGE')
  }

  const refs: DocumentAttachmentRef[] = []
  for (const document of decoded) {
    const input: SaveFileAttachment = document
    const saved = await attachments.saveFile(input)
    refs.push({
      attachmentId: saved.attachmentId,
      mediaType: document.mediaType,
      bytes: document.data.byteLength,
      name: document.name,
    })
  }
  return refs
}
