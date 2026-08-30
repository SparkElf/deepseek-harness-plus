/** Authenticated mixed prompt admission for parsed document attachments. */

import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  AttachmentError,
  admitEncodedImages,
} from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentStore,
  EncodedImageAttachment,
  ImageAttachmentRef,
  ImageMediaType,
  SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import { DocumentParserError } from './error.ts'
import type {
  DocumentAttachmentRef,
  DocumentMediaType,
  DocumentParseResult,
  FileAttachmentRef,
  ParsedDocumentRef,
} from './types.ts'
import type { DocumentParserRuntime } from './index.ts'

/** Exact privileged browser route owned by this capability. */
const DOCUMENT_PROMPT_PATH = '/api/document.prompt'

const DOCUMENT_EXTENSIONS: Readonly<Record<DocumentMediaType, string>> = Object.freeze({
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
})
const DOCUMENT_MEDIA_TYPES: ReadonlySet<string> = new Set(Object.keys(DOCUMENT_EXTENSIONS))
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

interface DocumentAttachmentLimits {
  readonly maxDocumentBytes: number
  readonly maxDocumentsPerMessage: number
  readonly maxMessageDocumentBytes: number
  readonly mediaTypes: readonly DocumentMediaType[]
}

interface DocumentAttachmentStore {
  readonly documentLimits: DocumentAttachmentLimits
  saveFile(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<FileAttachmentRef>
  saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>
}

interface PreparedPromptRequest {
  readonly sessionId: string
  readonly requestId: string
  readonly mode: 'steer' | 'followup'
  readonly clientTimeZone?: string
}

interface PreparedPromptController {
  promptPrepared(
    request: PreparedPromptRequest,
    hasImage: boolean,
    prepare: () => Promise<ContentBlock[]>,
  ): Promise<{ accepted: true }>
}

interface WireTextPart { readonly type: 'text'; readonly text: string }
interface WireImagePart extends EncodedImageAttachment { readonly type: 'image' }
interface WireDocumentPart {
  readonly type: 'document'
  readonly mediaType: DocumentMediaType
  readonly data: string
  readonly name: string
}
type WirePromptPart = WireTextPart | WireImagePart | WireDocumentPart

interface DocumentPromptRequest extends PreparedPromptRequest {
  readonly content: readonly WirePromptPart[]
}

interface DecodedDocument {
  readonly data: Uint8Array
  readonly mediaType: DocumentMediaType
  readonly name: string
}

interface ParsedDocument {
  readonly attachment: DocumentAttachmentRef
  readonly result: DocumentParseResult
  readonly parser: string
  readonly modelText: Uint8Array
}

interface DocumentBlock {
  readonly type: 'document'
  readonly attachment: DocumentAttachmentRef
  readonly parsed: ParsedDocumentRef
}

class DocumentInputError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DocumentInputError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new DocumentInputError('INVALID_REQUEST', `${key} must be a string`)
  return value
}

function parsePart(value: unknown): WirePromptPart {
  if (!isRecord(value)) throw new DocumentInputError('INVALID_REQUEST', 'content entries must be objects')
  const type = requiredString(value, 'type')
  if (type === 'text') return { type, text: requiredString(value, 'text') }
  if (type === 'image') {
    const mediaType = requiredString(value, 'mediaType')
    if (!IMAGE_MEDIA_TYPES.has(mediaType)) throw new DocumentInputError('INVALID_REQUEST', 'image mediaType is unsupported')
    const name = value.name
    if (name !== undefined && typeof name !== 'string') throw new DocumentInputError('INVALID_REQUEST', 'image name must be a string')
    return {
      type,
      mediaType: mediaType as ImageMediaType,
      data: requiredString(value, 'data'),
      ...(name === undefined ? {} : { name }),
    }
  }
  if (type === 'document') {
    const mediaType = requiredString(value, 'mediaType')
    if (!DOCUMENT_MEDIA_TYPES.has(mediaType)) throw new DocumentInputError('INVALID_REQUEST', 'document mediaType is unsupported')
    return {
      type,
      mediaType: mediaType as DocumentMediaType,
      data: requiredString(value, 'data'),
      name: requiredString(value, 'name'),
    }
  }
  throw new DocumentInputError('INVALID_REQUEST', 'content entry type is unsupported')
}

function parsePromptRequest(value: unknown): DocumentPromptRequest {
  if (!isRecord(value)) throw new DocumentInputError('INVALID_REQUEST', 'request body must be an object')
  const mode = requiredString(value, 'mode')
  if (mode !== 'steer' && mode !== 'followup') throw new DocumentInputError('INVALID_REQUEST', 'mode must be steer or followup')
  if (!Array.isArray(value.content) || value.content.length === 0) {
    throw new DocumentInputError('INVALID_REQUEST', 'content must be a non-empty array')
  }
  const clientTimeZone = value.clientTimeZone
  if (clientTimeZone !== undefined && typeof clientTimeZone !== 'string') {
    throw new DocumentInputError('INVALID_REQUEST', 'clientTimeZone must be a string')
  }
  return {
    sessionId: requiredString(value, 'sessionId'),
    requestId: requiredString(value, 'requestId'),
    mode,
    content: value.content.map(parsePart),
    ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
  }
}

function decodeCanonicalBase64(value: string): Uint8Array {
  const decoded = Buffer.from(value, 'base64')
  if (value.length === 0 || decoded.toString('base64') !== value) {
    throw new DocumentInputError('INVALID_DOCUMENT_BASE64', 'Document upload is not canonical base64.')
  }
  return new Uint8Array(decoded)
}

function displayName(value: string): string {
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)
  if (clean === '') throw new DocumentInputError('INVALID_DOCUMENT', 'Document name is empty after normalization.')
  return clean
}

function hasDocumentSignature(data: Uint8Array, mediaType: DocumentMediaType): boolean {
  if (mediaType === 'application/pdf') {
    return data.byteLength >= 5 && data[0] === 0x25 && data[1] === 0x50
      && data[2] === 0x44 && data[3] === 0x46 && data[4] === 0x2d
  }
  return data.byteLength >= 4 && data[0] === 0x50 && data[1] === 0x4b
    && ((data[2] === 0x03 && data[3] === 0x04)
      || (data[2] === 0x05 && data[3] === 0x06)
      || (data[2] === 0x07 && data[3] === 0x08))
}

function decodeDocuments(
  parts: readonly WireDocumentPart[],
  limits: DocumentAttachmentLimits,
): DecodedDocument[] {
  if (parts.length > limits.maxDocumentsPerMessage) {
    throw new DocumentInputError('TOO_MANY_DOCUMENTS', 'Document batch exceeds the configured document-count limit.')
  }
  const decoded: DecodedDocument[] = []
  let totalBytes = 0
  for (const part of parts) {
    if (!limits.mediaTypes.includes(part.mediaType)) {
      throw new DocumentInputError('UNSUPPORTED_DOCUMENT_TYPE', `Document type ${part.mediaType} is not accepted by this deployment.`)
    }
    const name = displayName(part.name)
    if (!name.toLowerCase().endsWith(DOCUMENT_EXTENSIONS[part.mediaType])) {
      throw new DocumentInputError('DOCUMENT_TYPE_MISMATCH', 'Document filename extension does not match the declared media type.')
    }
    const data = decodeCanonicalBase64(part.data)
    if (data.byteLength > limits.maxDocumentBytes) {
      throw new DocumentInputError('DOCUMENT_TOO_LARGE', 'Document exceeds the configured byte limit.')
    }
    if (!hasDocumentSignature(data, part.mediaType)) {
      throw new DocumentInputError('INVALID_DOCUMENT', 'Document bytes do not match the required container signature.')
    }
    totalBytes += data.byteLength
    decoded.push({ data, mediaType: part.mediaType, name })
  }
  if (totalBytes > limits.maxMessageDocumentBytes) {
    throw new DocumentInputError('DOCUMENTS_TOO_LARGE', 'Document batch exceeds the configured aggregate byte limit.')
  }
  return decoded
}

function renderModelText(attachment: DocumentAttachmentRef, markdown: Uint8Array): Uint8Array {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(markdown)
  return new TextEncoder().encode(
    `[attached document: ${attachment.name} (${attachment.mediaType}); parsed contents follow]\n\n${text}\n\n[end attached document: ${attachment.name}]`,
  )
}

async function prepareDocuments(
  store: DocumentAttachmentStore,
  parser: DocumentParserRuntime,
  parts: readonly WireDocumentPart[],
  signal: AbortSignal,
): Promise<DocumentBlock[]> {
  const decoded = decodeDocuments(parts, store.documentLimits)
  const parsed: ParsedDocument[] = []
  let modelBytes = 0
  for (const document of decoded) {
    signal.throwIfAborted()
    const original = await store.saveFile(document)
    const attachment: DocumentAttachmentRef = {
      attachmentId: original.attachmentId,
      mediaType: document.mediaType,
      bytes: original.bytes,
      name: original.name ?? document.name,
    }
    const output = await parser.parse({ attachment, data: document.data }, signal)
    const modelText = renderModelText(attachment, output.result.markdown)
    modelBytes += modelText.byteLength
    parsed.push({ attachment, result: output.result, parser: output.parser, modelText })
  }
  if (modelBytes > parser.maxDirectMarkdownBytes) {
    throw new DocumentParserError(
      'Parsed document content exceeds the configured direct-context byte limit.',
      'DOCUMENT_PARSE_CONTEXT_TOO_LARGE',
    )
  }

  const imageInputs: SaveImageAttachment[] = []
  for (const document of parsed) {
    for (const image of document.result.images) imageInputs.push(image)
  }
  const imageRefs = await store.saveImages(imageInputs)
  let imageOffset = 0
  const blocks: DocumentBlock[] = []
  for (const document of parsed) {
    const images = imageRefs.slice(imageOffset, imageOffset + document.result.images.length)
    imageOffset += images.length
    const markdown = await store.saveFile({
      data: document.result.markdown,
      mediaType: 'text/markdown; charset=utf-8',
      name: `${document.attachment.name}.md`,
    })
    const modelText = await store.saveFile({
      data: document.modelText,
      mediaType: 'text/plain; charset=utf-8',
      name: `${document.attachment.name}.model.txt`,
    })
    const contentList = await store.saveFile({
      data: document.result.contentList,
      mediaType: 'application/json',
      name: `${document.attachment.name}.content-list.json`,
    })
    blocks.push({
      type: 'document',
      attachment: document.attachment,
      parsed: { parser: document.parser, markdown, modelText, contentList, images: [...images] },
    })
  }
  return blocks
}

async function preparePromptContent(
  attachments: AttachmentStore,
  store: DocumentAttachmentStore,
  parser: DocumentParserRuntime,
  parts: readonly WirePromptPart[],
  signal: AbortSignal,
): Promise<ContentBlock[]> {
  const images = parts.filter((part): part is WireImagePart => part.type === 'image')
  const documents = parts.filter((part): part is WireDocumentPart => part.type === 'document')
  const imageRefs = await admitEncodedImages(attachments, images)
  const documentBlocks = await prepareDocuments(store, parser, documents, signal)
  let imageIndex = 0
  let documentIndex = 0
  const content: Array<ContentBlock | DocumentBlock> = []
  for (const part of parts) {
    if (part.type === 'text') content.push({ type: 'text', text: part.text })
    else if (part.type === 'image') content.push({ type: 'image', attachment: imageRefs[imageIndex++] as ImageAttachmentRef })
    else content.push(documentBlocks[documentIndex++] as DocumentBlock)
  }
  // The source patch extends ContentBlock with DocumentBlock; the npm package stays buildable against the unpatched official manifest.
  return content as unknown as ContentBlock[]
}

async function readBoundedJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = request.headers['content-length']
  if (declared !== undefined && Number(declared) > maxBytes) {
    throw new DocumentInputError('REQUEST_TOO_LARGE', 'Document prompt request exceeds the configured byte limit.')
  }
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += value.byteLength
    if (bytes > maxBytes) throw new DocumentInputError('REQUEST_TOO_LARGE', 'Document prompt request exceeds the configured byte limit.')
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown
  } catch (error) {
    console.error('document-attachments: request JSON parsing failed', error)
    throw new DocumentInputError('INVALID_REQUEST', 'Document prompt request is not valid JSON.', { cause: error })
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

function sendFailure(response: ServerResponse, error: unknown): void {
  console.error('document-attachments: prompt admission failed', error)
  if (error instanceof DocumentInputError || error instanceof DocumentParserError || error instanceof AttachmentError) {
    sendJson(response, 400, { ok: false, error: { code: error.code, message: error.message, details: {} } })
    return
  }
  if (error instanceof TypertRemoteFailure) {
    sendJson(response, 409, { ok: false, error: error.failure })
    return
  }
  sendJson(response, 500, { ok: false, error: { code: 'DOCUMENT_PROMPT_FAILED', message: 'Unable to submit the document prompt.', details: {} } })
}

/**
 * Register the authenticated mixed prompt route for this capability.
 * @param ctx - Host context carrying WebServer, Connection, Attachment, and Session Controller services.
 * @param parser - provider-neutral parser runtime.
 * @param maxRequestBytes - exact encoded HTTP body limit.
 * @returns route disposer owned by the Document parser Service fiber.
 */
export function registerDocumentPromptRoute(
  ctx: Context,
  parser: DocumentParserRuntime,
  maxRequestBytes: number,
): () => void {
  const attachments = ctx.attachments
  const store = attachments as unknown as DocumentAttachmentStore
  const sessions = ctx.sessionController as unknown as PreparedPromptController
  return ctx.webServer.register({
    kind: 'exact',
    path: DOCUMENT_PROMPT_PATH,
    handler: async (request, response) => {
      const rejection = ctx.connection.requestRejection(request)
      if (rejection !== undefined) {
        response.writeHead(rejection)
        response.end()
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      const abort = new AbortController()
      const onAborted = (): void => { abort.abort(new Error('Document prompt request was aborted.')) }
      request.once('aborted', onAborted)
      try {
        const body = parsePromptRequest(await readBoundedJson(request, maxRequestBytes))
        const value = await sessions.promptPrepared(
          body,
          body.content.some(part => part.type === 'image'),
          () => preparePromptContent(attachments, store, parser, body.content, abort.signal),
        )
        sendJson(response, 200, { ok: true, value })
      } catch (error) {
        sendFailure(response, error)
      } finally {
        request.off('aborted', onAborted)
      }
    },
  })
}
