/** Provider-neutral document parsing vocabulary. @module @deepseek-ai/dsh-document-parser/types */

import type { DocumentAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Stable parser failure codes used by Host admission and provider diagnostics. */
export type DocumentParserErrorCode =
  | 'DOCUMENT_PARSER_DUPLICATE_PROVIDER'
  | 'DOCUMENT_PARSER_CONFIGURED_MISSING'
  | 'DOCUMENT_PARSER_UNAVAILABLE'
  | 'DOCUMENT_PARSER_AMBIGUOUS'
  | 'DOCUMENT_PARSE_FAILED'
  | 'DOCUMENT_PARSE_INVALID_OUTPUT'
  | 'DOCUMENT_PARSE_RESPONSE_TOO_LARGE'
  | 'DOCUMENT_PARSE_TIMEOUT'
  | 'DOCUMENT_PARSE_ABORTED'
  | 'DOCUMENT_PARSE_CONTEXT_TOO_LARGE'


/** One already-persisted original document supplied to a parser provider. */
export interface DocumentParseRequest {
  /** Durable original-document metadata. */
  attachment: DocumentAttachmentRef
  /** Exact original bytes resolved from the durable attachment store. */
  data: Uint8Array
}

/** One extracted raster image returned by a parser before durable persistence. */
export interface ParsedDocumentImage {
  /** Parser-relative display name only; never a host storage path. */
  name: string
  /** Declared raster media type validated again by the attachment store on persistence. */
  mediaType: ImageMediaType
  /** Exact extracted image bytes. */
  data: Uint8Array
}

/** Complete parser output required by the version-one durable document path. */
export interface DocumentParseResult {
  /** Complete UTF-8 Markdown bytes used for direct model projection. */
  markdown: Uint8Array
  /** Complete UTF-8 JSON bytes for the parser's reading-order content list. */
  contentList: Uint8Array
  /** Extracted raster images in parser output order. */
  images: readonly ParsedDocumentImage[]
}

/** External parser implementation registered into {@link DocumentParserRuntime}. */
export interface DocumentParserProvider {
  /** Stable provider id used by explicit deployment selection and durable parse provenance. */
  readonly id: string
  /**
   * Parse one original document into the complete version-one output bundle.
   * @param request - original durable metadata and verified bytes.
   * @param signal - optional caller cancellation.
   * @returns complete Markdown, content-list JSON, and extracted images.
   */
  parse(request: DocumentParseRequest, signal?: AbortSignal): Promise<DocumentParseResult>
}
