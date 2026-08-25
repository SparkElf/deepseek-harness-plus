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

function logProviderError(operation: string, error: unknown): void {
  console.error(`document-parser-mineru: ${operation}`, error)
}

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

  async parse(request: DocumentParseRequest, signal?: AbortSignal): Promise<DocumentParseResult> {
    // 每次调用只对应一个已持久化原件；同步响应必须在本次准入内形成完整Markdown/content-list/images bundle。
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const form = new FormData()
    const fileBytes = new Uint8Array(request.data.byteLength)
    fileBytes.set(request.data)
    form.append(
      'files',
      new Blob([fileBytes.buffer], { type: request.attachment.mediaType }),
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
      logProviderError('request failed', error)
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
      archive = await readBoundedBody(response, this.maxResponseBytes)
    } catch (error: unknown) {
      logProviderError('response read failed', error)
      if (error instanceof DocumentParserError) throw error
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

    return parseArchive(unzipBounded(archive, this.maxResponseBytes))
  }
}

/** Read a response body and reject as soon as accumulated compressed bytes exceed the configured bound. */
async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      const value = part.value
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel()
        } catch (error: unknown) {
          logProviderError('oversized response cancellation failed', error)
        }
        throw new DocumentParserError(
          'Document parser response exceeds the configured byte limit.',
          'DOCUMENT_PARSE_RESPONSE_TOO_LARGE',
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/** Reject archives whose declared aggregate uncompressed size exceeds the bound before fflate allocates the entries. */
function unzipBounded(archive: Uint8Array, maxBytes: number): Record<string, Uint8Array> {
  let declaredBytes = 0
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(archive, {
      filter(file) {
        if (declaredBytes > maxBytes) return false
        declaredBytes += file.originalSize
        return declaredBytes <= maxBytes
      },
    })
  } catch (error: unknown) {
    logProviderError('ZIP extraction failed', error)
    throw new DocumentParserError('Document parser returned an invalid ZIP archive.', 'DOCUMENT_PARSE_INVALID_OUTPUT', { cause: error })
  }
  if (declaredBytes > maxBytes) {
    throw new DocumentParserError(
      'Document parser extracted output exceeds the configured byte limit.',
      'DOCUMENT_PARSE_RESPONSE_TOO_LARGE',
    )
  }
  return entries
}

/** Validate a configured HTTP(S) parser endpoint without silently rewriting it. */
function parseEndpoint(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error: unknown) {
    logProviderError('endpoint parsing failed', error)
    throw new Error('document-parser-mineru: endpoint must be an absolute URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('document-parser-mineru: endpoint must use http or https')
  }
  return url.toString()
}

/**
 * Select exactly one v1 Markdown and content-list output plus every extracted raster image.
 * @param entries - bounded in-memory ZIP entries from one synchronous MinerU response.
 * @returns validated complete transient parser output bytes.
 */
export function parseArchive(entries: Readonly<Record<string, Uint8Array>>): DocumentParseResult {
  const files = Object.entries(entries).filter(([name]) => !name.endsWith('/'))
  const markdown = files.filter(([name]) => name.toLowerCase().endsWith('.md'))
  const contentLists = files.filter(([name]) => {
    const lower = name.toLowerCase()
    return lower.endsWith('_content_list.json') && !lower.endsWith('_content_list_v2.json')
  })
  const markdownEntry = markdown[0]
  const contentListEntry = contentLists[0]
  if (markdown.length !== 1 || contentLists.length !== 1 || markdownEntry === undefined || contentListEntry === undefined) {
    throw new DocumentParserError(
      'Document parser ZIP must contain exactly one Markdown file and one content-list JSON file.',
      'DOCUMENT_PARSE_INVALID_OUTPUT',
    )
  }
  const markdownBytes = markdownEntry[1]
  const contentListBytes = contentListEntry[1]

  validateUtf8(markdownBytes, 'Markdown')
  const contentListText = validateUtf8(contentListBytes, 'content-list JSON')
  try {
    const parsed = JSON.parse(contentListText) as unknown
    if (!Array.isArray(parsed)) throw new Error('content list is not an array')
  } catch (error: unknown) {
    logProviderError('content-list validation failed', error)
    throw new DocumentParserError('Document parser content-list output is not a JSON array.', 'DOCUMENT_PARSE_INVALID_OUTPUT', { cause: error })
  }

  const images: ParsedDocumentImage[] = []
  for (const [path, data] of files) {
    if (!path.split('/').includes('images')) continue
    const name = path.slice(path.lastIndexOf('/') + 1)
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
    logProviderError(`${label} UTF-8 decoding failed`, error)
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
