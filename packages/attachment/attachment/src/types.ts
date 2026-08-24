/** Durable attachment vocabulary. @module @deepseek-ai/dsh-attachment/types */

import type { AttachmentId } from './brand.ts'

export type { AttachmentId } from './brand.ts'

/** Raster image formats accepted by the version-one image attachment path. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Human-document formats accepted by the first durable document path. */
export type DocumentMediaType =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Generic immutable file-object metadata for document/parser artifacts. */
export interface FileAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Caller-owned media type for this generic file object. */
  mediaType: string
  /** Exact encoded byte length. */
  bytes: number
  /** Optional display name stripped of local path information. */
  name?: string
}

/** Durable, serializable metadata for one immutable image object. */
export interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
}

/** Durable metadata for one supported user-authored document. */
export interface DocumentAttachmentRef extends Omit<FileAttachmentRef, 'mediaType' | 'name'> {
  /** Exact supported document media type admitted with the original bytes. */
  mediaType: DocumentMediaType
  /** Browser/provider display name after path stripping and control-character cleanup. */
  name: string
}

/**
 * Durable parser outputs associated with one original document. The session
 * records only immutable attachment references; parser response paths and
 * transient extracted bytes never become session state.
 */
export interface ParsedDocumentRef {
  /** Provider id that produced this immutable parse bundle. */
  parser: string
  /** Complete parsed Markdown used for direct model projection. */
  markdown: FileAttachmentRef
  /** Complete parser structural block list retained for future document tools. */
  contentList: FileAttachmentRef
  /** Extracted raster images in parser output order. */
  images: readonly ImageAttachmentRef[]
}

/** Deployment-resolved limits used by image upload admission and request buffering. */
export interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  /** Maximum intrinsic width and maximum intrinsic height in pixels for one image. */
  maxImageDimension: number
  mediaTypes: readonly ImageMediaType[]
}

/** Deployment-resolved limits used by document upload admission and request buffering. */
export interface DocumentAttachmentLimits {
  /** Maximum encoded bytes admitted for one supported document. */
  maxDocumentBytes: number
  /** Maximum number of supported documents admitted in one submitted message. */
  maxDocumentsPerMessage: number
  /** Maximum aggregate encoded document bytes admitted in one submitted message. */
  maxMessageDocumentBytes: number
  /** Exact document media types accepted by this deployment. */
  mediaTypes: readonly DocumentMediaType[]
}

/** Base64-encoded image upload accompanying one wire request. */
export interface EncodedImageAttachment {
  /** Declared media type, verified against the decoded bytes during admission. */
  mediaType: ImageMediaType
  /** Canonical base64 encoding of the image bytes. */
  data: string
  /** Optional display name; it is never interpreted as a path. */
  name?: string
}

/** Base64-encoded supported document accompanying one wire request. */
export interface EncodedDocumentAttachment {
  /** Declared document media type admitted before persistence. */
  mediaType: DocumentMediaType
  /** Canonical base64 encoding of the document bytes. */
  data: string
  /** Required display name; it is never interpreted as a storage path. */
  name: string
}

/** Generic immutable bytes to commit to the shared content-addressed object store. */
export interface SaveFileAttachment {
  /** Already-admitted immutable bytes to persist. */
  data: Uint8Array
  /** Caller-owned media type recorded beside the immutable object reference. */
  mediaType: string
  /** Optional display name; storage providers must never treat it as a path. */
  name?: string
}

/** Request to validate and durably commit one image. */
export interface SaveImageAttachment {
  data: Uint8Array
  /** Caller-declared media type, checked against fully decoded bytes. */
  mediaType: ImageMediaType
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string
}

/** Request to durably commit one already-admitted user document. */
export interface SaveDocumentAttachment {
  /** Already-admitted original document bytes. */
  data: Uint8Array
  /** Exact supported document media type. */
  mediaType: DocumentMediaType
  /** Required normalized display name; never a storage path. */
  name: string
}

/** Stored generic file bytes returned after reference and digest verification. */
export interface StoredFileAttachment {
  /** Canonical durable reference verified against the returned bytes. */
  ref: FileAttachmentRef
  /** Immutable stored bytes after digest and byte-length verification. */
  data: Uint8Array
}

/** Stored image bytes returned after reference and digest verification. */
export interface StoredImageAttachment {
  ref: ImageAttachmentRef
  data: Uint8Array
}

/** Stored document bytes returned after reference and digest verification. */
export interface StoredDocumentAttachment {
  /** Canonical supported-document reference verified against the returned bytes. */
  ref: DocumentAttachmentRef
  /** Immutable original document bytes. */
  data: Uint8Array
}
