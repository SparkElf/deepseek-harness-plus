/** Synchronous MinerU `/file_parse` document parser provider. */

import { unzipSync } from 'fflate'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import {
  DocumentParserError,
  type DocumentParseRequest,
  type DocumentParseResult,
  type DocumentParserProvider,
  type ParsedDocumentImage,
} from '@deepseek-ai/dsh-document-parser'

/** Stable parser-provider id recorded with durable parse provenance. */
export const MINERU_PROVIDER_ID = 'mineru'

/** Fully resolved MinerU HTTP policy. Every value is deployment-owned. */
export interface MinerUProviderOptions {
  /** Absolute synchronous `POST /file_parse` endpoint. */
  endpoint: string
  /** Maximum wall-clock time for one parse request. */
  timeoutMs: number
  /** Maximum compressed HTTP body and aggregate extracted output bytes. */
  maxResponseBytes: number
}

/** MinerU external parser implementation. */
export class MinerUDocumentParserProvider implements DocumentParserProvider {
  readonly id = MINERU_PROVIDER_ID
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number

  constructor(options: MinerUProviderOptions) {
    const endpoint = parseEndpoint(options.endpoint)
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('document-parser-mineru: timeoutMs must be a positive safe integer')
    }
    if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0) {
      throw new Error('document-parser-mineru: maxResponseBytes must be a positive safe integer')
    }
    this.endpoint = endpoint
    this.timeoutMs = options.timeoutMs
    this.maxResponseBytes = options.maxResponseBytes
  }

  available(): boolean {
    return true
  }

  async parse(request: DocumentParseRequest, signal?: AbortSignal): Promise<DocumentParseResult> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const form = new FormData()
    form.append(
      'files',
      new Blob([request.data], { type: request.attachment.mediaType }),
      request.attachment.name,
    )
    form.append('return_md', 'true')
    form.append('return_middle_json', 'false')
    form.append('return_model_output', 'false')
    form.append('return_content_list', 'true')
    form.append('return_images', 'true')
    form.append('response_format_zip', 'true')
    form.append('return_original_file', 'false')

    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        redirect: 'error',
        body: form,
        signal: combined,
      })
    } catch (error: unknown) {
      if (signal?.aborted === true) {
        throw new DocumentParserError('Document parsing was cancelled.', 'DOCUMENT_PARSE_ABORTED', { cause: error })
      }
      if (timeout.aborted) {
        throw new DocumentParserError(
          `Document parsing exceeded the configured ${this.timeoutMs} ms timeout.`,
          'DOCUMENT_PARSE_TIMEOUT',
          { cause: error },
        )
      }
      throw new DocumentParserError('Unable to reach the configured document parser.', 'DOCUMENT_PARSE_FAILED', { cause: error })
    }

    if (!response.ok) {
      throw new DocumentParserError(
        `Document parser returned HTTP ${response.status}.`,
        'DOCUMENT_PARSE_FAILED',
      )
    }
    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null) {
      const bytes = Number(declaredLength)
      if (Number.isFinite(bytes) && bytes > this.maxResponseBytes) {
        throw new DocumentParserError(
          'Document parser response exceeds the configured byte limit.',
          'DOCUMENT_PARSE_RESPONSE_TOO_LARGE',
        )
      }
    }

    let archive: Uint8Array
    try {
      archive = new Uint8Array(await response.arrayBuffer())
    } catch (error: unknown) {
      if (signal?.aborted === true) {
        throw new DocumentParserError('Document parsing was cancelled.', 'DOCUMENT_PARSE_ABORTED', { cause: error })
      }
      if (timeout.aborted) {
        throw new DocumentParserError(
          `Document parsing exceeded the configured ${this.timeoutMs} ms timeout.`,
          'DOCUMENT_PARSE_TIMEOUT',
          { cause: error },
        )
      }
      throw new DocumentParserError('Unable to read the document parser response.', 'DOCUMENT_PARSE_FAILED', { cause: error })
    }
    if (archive.byteLength > this.maxResponseBytes) {
      throw new DocumentParserError(
        'Document parser response exceeds the configured byte limit.',
        'DOCUMENT_PARSE_RESPONSE_TOO_LARGE',
      )
    }

    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(archive)
    } catch (error: unknown) {
      throw new DocumentParserError('Document parser returned an invalid ZIP archive.', 'DOCUMENT_PARSE_INVALID_OUTPUT', { cause: error })
    }
    const extractedBytes = Object.values(entries).reduce((sum, value) => sum + value.byteLength, 0)
    if (!Number.isSafeInteger(extractedBytes) || extractedBytes > this.maxResponseBytes) {
      throw new DocumentParserError(
        'Document parser extracted output exceeds the configured byte limit.',
        'DOCUMENT_PARSE_RESPONSE_TOO_LARGE',
      )
    }

    return parseArchive(entries)
  }
}

/** Validate a configured HTTP(S) parser endpoint without silently rewriting it. */
function parseEndpoint(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error: unknown) {
    throw new Error('document-parser-mineru: endpoint must be an absolute URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('document-parser-mineru: endpoint must use http or https')
  }
  return url.toString()
}

/** Select exactly one v1 Markdown and content-list output plus every extracted raster image. */
export function parseArchive(entries: Readonly<Record<string, Uint8Array>>): DocumentParseResult {
  const files = Object.entries(entries).filter(([name]) => !name.endsWith('/'))
  const markdown = files.filter(([name]) => name.toLowerCase().endsWith('.md'))
  const contentLists = files.filter(([name]) => {
    const lower = name.toLowerCase()
    return lower.endsWith('_content_list.json') && !lower.endsWith('_content_list_v2.json')
  })
  if (markdown.length !== 1 || contentLists.length !== 1) {
    throw new DocumentParserError(
      'Document parser ZIP must contain exactly one Markdown file and one content-list JSON file.',
      'DOCUMENT_PARSE_INVALID_OUTPUT',
    )
  }
  const markdownBytes = markdown[0]?.[1]
  const contentListBytes = contentLists[0]?.[1]
  if (markdownBytes === undefined || contentListBytes === undefined) {
    throw new DocumentParserError('Document parser ZIP is missing required outputs.', 'DOCUMENT_PARSE_INVALID_OUTPUT')
  }

  validateUtf8(markdownBytes, 'Markdown')
  const contentListText = validateUtf8(contentListBytes, 'content-list JSON')
  try {
    const parsed = JSON.parse(contentListText) as unknown
    if (!Array.isArray(parsed)) throw new Error('content list is not an array')
  } catch (error: unknown) {
    throw new DocumentParserError('Document parser content-list output is not a JSON array.', 'DOCUMENT_PARSE_INVALID_OUTPUT', { cause: error })
  }

  const images: ParsedDocumentImage[] = []
  for (const [path, data] of files) {
    if (!path.split('/').includes('images')) continue
    const name = path.split('/').at(-1)
    if (name === undefined || name.length === 0) continue
    const mediaType = imageMediaType(name)
    if (mediaType === undefined) {
      throw new DocumentParserError(
        `Document parser returned unsupported extracted image type for "${name}".`,
        'DOCUMENT_PARSE_INVALID_OUTPUT',
      )
    }
    images.push({ name, mediaType, data })
  }

  return { markdown: markdownBytes, contentList: contentListBytes, images }
}

/** Strict UTF-8 decoder used before parser output is accepted for durable persistence. */
function validateUtf8(data: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch (error: unknown) {
    throw new DocumentParserError(`Document parser ${label} is not valid UTF-8.`, 'DOCUMENT_PARSE_INVALID_OUTPUT', { cause: error })
  }
}

/** MIME owned by the existing raster attachment admission path. */
function imageMediaType(name: string): ImageMediaType | undefined {
  const lower = name.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return undefined
}
