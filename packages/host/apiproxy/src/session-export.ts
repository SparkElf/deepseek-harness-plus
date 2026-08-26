/**
 * Host-side session-log download: streams one ZIP archive whose files are the
 * sessions' stored artifact text verbatim plus every referenced attachment
 * object. The root artifact sits under its original base name (`session.jsonl`);
 * each subagent descendant under `subagents/<id>/<filename>`; each image under
 * `media/<attachmentId>.<ext>`, each original document under `documents/`, and
 * each parsed Markdown/content-list object under `parsed/`. References sharing the same immutable id
 * and media type land once. No manifest is written — every file is byte-identical
 * to the backend's durable artifact or attachment store and maps back through
 * the durable reference recorded in the log. Before each live session's artifact
 * read, the SessionStore flush barrier makes the current in-memory log durable;
 * cold sessions need no barrier. Request abort and response-consumer cancellation
 * share one producer signal and terminate the active compressor.
 * Compression runs on the host with fflate's streaming Zip API, so the archive
 * bytes are produced incrementally and the host never holds the whole archive
 * in one buffer; production waits for consumer pull whenever the response queue
 * reaches its byte high-water mark, so a slow consumer bounds accumulation to
 * the fixed 64 KiB response queue plus one synchronous fflate push.
 * @module
 */

import { Zip, ZipDeflate } from 'fflate'
import type { Context } from '@deepseek-ai/cordis'
import type {
  AttachmentStore,
  DocumentAttachmentRef,
  DocumentMediaType,
  FileAttachmentRef,
  ImageAttachmentRef,
  ParsedDocumentRef,
} from '@deepseek-ai/dsh-attachment'
import type { SessionLineageNode, SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionRawArtifact } from '@deepseek-ai/dsh-session-persistence'

/** Valid fflate DEFLATE levels accepted by session-log export. */
export type SessionLogCompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/** Balanced default used when a direct createApiProxy caller omits deployment config. */
export const DEFAULT_SESSION_LOG_COMPRESSION_LEVEL: SessionLogCompressionLevel = 6

/** The services a session-log export needs (the live-session store is optional). */
export interface SessionLogExportDeps {
  readonly sessionQuery: SessionQueryEngine | undefined
  readonly sessionPersistence: SessionPersistence | undefined
  readonly attachments: AttachmentStore | undefined
  readonly sessions: SessionStore | undefined
}

/** The export services narrowed to the mounted ones streaming actually reads. */
export interface SessionLogExportReady {
  readonly sessionQuery: SessionQueryEngine
  readonly sessionPersistence: SessionPersistence
  readonly attachments: AttachmentStore
  readonly sessions: SessionStore | undefined
}

/**
 * Resolve the persistence, session-query, and attachment services a log export needs.
 * @param ctx - the composed host context.
 * @returns the export services (absent when the deployment does not mount them).
 */
export function sessionLogExportDeps(ctx: Context): SessionLogExportDeps {
  return {
    sessionQuery: ctx.get('sessionQuery'),
    sessionPersistence: ctx.get('sessionPersistence'),
    attachments: ctx.get('attachments'),
    sessions: ctx.get('sessions'),
  }
}

/**
 * Flush one currently live session through the store's authoritative durability
 * barrier immediately before its raw artifact is read. A cold or absent id has
 * no in-memory work to flush.
 * @param deps - export services, including the optional live-session store.
 * @param id - the session whose artifact is about to be read.
 * @param signal - optional cancellation observed around the flush barrier.
 */
export async function flushLiveSessionLog(
  deps: Pick<SessionLogExportDeps, 'sessions'>,
  id: SessionId,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const sessions = deps.sessions
  if (sessions === undefined) return
  const session = sessions.get(id)
  if (session === undefined) return
  await sessions.flush(session)
  signal?.throwIfAborted()
}

/** One exported file: a stored artifact text or one referenced attachment object. */
export type SessionLogZipEntry =
  | { readonly path: string; readonly content: string }
  | { readonly path: string; readonly data: Uint8Array }

/** Zip extension for each accepted raster media type. */
const MEDIA_TYPE_EXTENSIONS: Record<ImageAttachmentRef['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** Zip extension for each durable generic document media type. */
const DOCUMENT_TYPE_EXTENSIONS: Record<DocumentMediaType, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
}

/**
 * The zip path for one media object: content-addressed by the opaque
 * attachment id so shared images land once and the id in the log maps back to
 * the archive entry without a manifest.
 * @param ref - the durable reference from a session log.
 * @returns the archive path.
 */
function mediaEntryPath(ref: ImageAttachmentRef): string {
  return `media/${String(ref.attachmentId)}.${MEDIA_TYPE_EXTENSIONS[ref.mediaType]}`
}

/** Stable archive path for one original generic document. */
function documentEntryPath(ref: DocumentAttachmentRef): string {
  return `documents/${String(ref.attachmentId)}.${DOCUMENT_TYPE_EXTENSIONS[ref.mediaType]}`
}

interface ArtifactAttachmentRefs {
  readonly images: Map<string, ImageAttachmentRef>
  /** Keyed by archive path so the same bytes under disagreeing OOXML metadata remain representable. */
  readonly documents: Map<string, DocumentAttachmentRef>
  /** Required parsed Markdown and content-list objects keyed by stable ref-derived archive path. */
  readonly files: Map<string, FileAttachmentRef>
}

/**
 * Collect every image/document reference inside one content array, descending
 * into nested tool results the way the live content scanners do.
 */
function collectAttachmentRefs(content: unknown, refs: ArtifactAttachmentRefs): void {
  // session ZIP必须遍历DocumentBlock的原件与完整parsed引用闭包，否则导出后无法重建相同模型输入。
  if (!Array.isArray(content)) return
  const pending: unknown[] = []
  for (const item of content) pending.push(item)
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { type?: unknown; attachment?: unknown; parsed?: unknown; content?: unknown }
    if (typeof block.attachment === 'object' && block.attachment !== null) {
      if (block.type === 'image') {
        const ref = block.attachment as ImageAttachmentRef
        refs.images.set(String(ref.attachmentId), ref)
      } else if (block.type === 'document') {
        const ref = block.attachment as DocumentAttachmentRef
        const parsed = block.parsed as ParsedDocumentRef
        refs.documents.set(documentEntryPath(ref), ref)
        refs.files.set(`parsed/${String(parsed.markdown.attachmentId)}.md`, parsed.markdown)
        refs.files.set(`parsed/${String(parsed.contentList.attachmentId)}.json`, parsed.contentList)
        for (const image of parsed.images) refs.images.set(String(image.attachmentId), image)
      }
    }
    if (Array.isArray(block.content)) {
      for (const item of block.content) pending.push(item)
    }
  }
}

/**
 * Collect every attachment reference one session event carries, across direct
 * content, message content, inserted messages, and completed assistant chunks.
 */
function collectEventAttachmentRefs(event: unknown, refs: ArtifactAttachmentRefs): void {
  const data = (event as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return
  const carrier = data as {
    content?: unknown
    message?: { content?: unknown }
    inserted?: Array<{ content?: unknown }>
    chunk?: { type?: unknown; block?: unknown }
  }
  collectAttachmentRefs(carrier.content, refs)
  if (carrier.message !== undefined) collectAttachmentRefs(carrier.message.content, refs)
  if (carrier.inserted !== undefined) {
    for (const message of carrier.inserted) collectAttachmentRefs(message.content, refs)
  }
  if (carrier.chunk?.type === 'block-end') collectAttachmentRefs([carrier.chunk.block], refs)
}

/**
 * Collect the distinct durable attachment references one stored artifact text
 * names. A malformed durable JSONL line fails export rather than returning a
 * seemingly complete archive that silently omits referenced durable objects.
 */
function attachmentRefsInArtifact(content: string): ArtifactAttachmentRefs {
  const refs: ArtifactAttachmentRefs = {
    images: new Map<string, ImageAttachmentRef>(),
    documents: new Map<string, DocumentAttachmentRef>(),
    files: new Map<string, FileAttachmentRef>(),
  }
  for (const line of content.split('\n')) {
    if (line === '') continue
    collectEventAttachmentRefs(JSON.parse(line) as unknown, refs)
  }
  return refs
}

/**
 * One safe zip path segment from an untrusted session id. Session ids are
 * host-controlled, but the brand allows any non-empty string, so `../`, dot
 * segments, and separator characters are neutralized before they can shape
 * archive entries. Distinct ids may collapse onto one segment (id collision
 * is impossible for the host-minted UUIDs, so no uniqueness suffix is kept).
 * @param id - the raw session id.
 * @returns a filesystem-safe single path segment.
 */
function safeSessionIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * The export archive filename for one root session.
 * @param sessionId - the root session id (sanitized to one safe path segment).
 * @returns the attachment filename for the session's export archive.
 */
export function sessionLogZipFilename(sessionId: string): string {
  return `dsh-session-${safeSessionIdSegment(sessionId)}.zip`
}

/**
 * Yield the export entries in zip order: the preloaded root artifact first,
 * then every subagent descendant in lineage order (each flushed when live,
 * read from the persistence backend right before it is yielded, and dropped
 * after the consumer moves on), then every distinct image, original document,
 * parsed Markdown, and content-list object referenced by any included log. Files are read through readFile,
 * so the same digest and byte-length verification used by the durable store is
 * performed during export. The host holds at most one descendant artifact and
 * one attachment object at a time beyond the root.
 * @param deps - the mounted export services (the caller answered 500 before this runs).
 * @param root - the already-read root artifact (read by the caller so the
 * missing-session path can answer cleanly before streaming starts).
 * @param sessionId - the root session id.
 * @param includeDescendants - whether to include every subagent descendant.
 * @param signal - optional cancellation forwarded to lineage, persistence, and attachment reads.
 * @returns the export entries in zip order.
 */
export async function* sessionLogZipEntries(
  deps: SessionLogExportReady,
  root: SessionRawArtifact,
  sessionId: SessionId,
  includeDescendants: boolean,
  signal?: AbortSignal,
): AsyncGenerator<SessionLogZipEntry> {
  const images = new Map<string, ImageAttachmentRef>()
  const documents = new Map<string, DocumentAttachmentRef>()
  const files = new Map<string, FileAttachmentRef>()
  const rememberAttachments = (content: string): void => {
    const refs = attachmentRefsInArtifact(content)
    for (const [id, ref] of refs.images) images.set(id, ref)
    for (const [path, ref] of refs.documents) documents.set(path, ref)
    for (const [path, ref] of refs.files) files.set(path, ref)
  }
  rememberAttachments(root.content)
  yield { path: root.filename, content: root.content }
  if (includeDescendants) {
    const seen = new Set<SessionId>([sessionId])
    const collect = async function* (
      nodes: readonly SessionLineageNode[],
    ): AsyncGenerator<SessionLogZipEntry> {
      for (const node of nodes) {
        signal?.throwIfAborted()
        const id = node.session.header.id
        if (seen.has(id)) continue
        seen.add(id)
        await flushLiveSessionLog(deps, id, signal)
        const raw = await deps.sessionPersistence.readRaw(id, signal)
        signal?.throwIfAborted()
        if (raw === undefined) {
          throw new Error(`subagent "${id}" has no stored log artifact`)
        }
        rememberAttachments(raw.content)
        yield {
          path: `subagents/${safeSessionIdSegment(id)}/${raw.filename}`,
          content: raw.content,
        }
        yield* collect(node.descendants)
      }
    }
    const lineage = await deps.sessionQuery.traceSession(sessionId, signal)
    signal?.throwIfAborted()
    yield* collect(lineage.descendants)
  }
  for (const ref of images.values()) {
    signal?.throwIfAborted()
    const stored = await deps.attachments.readImage(ref, signal)
    signal?.throwIfAborted()
    yield { path: mediaEntryPath(ref), data: stored.data }
  }
  for (const [path, ref] of [...documents, ...files]) {
    signal?.throwIfAborted()
    const stored = await deps.attachments.readFile(ref, signal)
    signal?.throwIfAborted()
    yield { path, data: stored.data }
  }
}

/** How many code units of artifact text one zip push carries (bounded encode memory). */
const PUSH_CHUNK_CODE_UNITS = 1 << 16

/** How many bytes of one attachment object each zip push carries. */
const PUSH_CHUNK_BYTES = 1 << 16

/** Byte capacity retained by the response stream before ZIP production waits for pull. */
const RESPONSE_HIGH_WATER_MARK_BYTES = 1 << 16

/** One producer waiter released only when ReadableStream pull restores capacity. */
class ResponseCapacityGate {
  private releasePending: (() => void) | undefined

  /**
   * Wait until the response queue has positive byte capacity or cancellation wins.
   * @param controller - response controller whose desired size owns capacity.
   * @param signal - combined request/consumer cancellation.
   */
  async wait(
    controller: ReadableStreamDefaultController<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    if (controller.desiredSize === null || controller.desiredSize > 0) return
    await new Promise<void>((resolve) => {
      const release = (): void => {
        this.releasePending = undefined
        signal.removeEventListener('abort', release)
        resolve()
      }
      this.releasePending = release
      signal.addEventListener('abort', release, { once: true })
    })
    signal.throwIfAborted()
  }

  /** Release the current producer waiter after a consumer pull. */
  pulled(): void {
    this.releasePending?.()
  }
}

/**
 * Push one attachment object's bytes into a deflate stream in bounded chunks,
 * waiting for consumer capacity between chunks like the artifact path does.
 * @param deflate - the zip entry's deflate stream.
 * @param data - the verified durable attachment bytes.
 * @param controller - response queue controller.
 * @param capacity - pull-driven response-capacity gate.
 * @param signal - cancellation; throws when aborted.
 */
async function pushBinaryChunks(
  deflate: ZipDeflate,
  data: Uint8Array,
  controller: ReadableStreamDefaultController<Uint8Array>,
  capacity: ResponseCapacityGate,
  signal: AbortSignal,
): Promise<void> {
  let offset = 0
  do {
    signal.throwIfAborted()
    const end = Math.min(offset + PUSH_CHUNK_BYTES, data.byteLength)
    const finalChunk = end >= data.byteLength
    deflate.push(data.subarray(offset, end), finalChunk)
    offset = end
    await capacity.wait(controller, signal)
  } while (offset < data.byteLength)
}

/**
 * Push one artifact's text into a deflate stream in bounded chunks, never
 * splitting a surrogate pair across a chunk boundary (a lone high surrogate
 * re-encodes as U+FFFD and would silently corrupt the exported artifact).
 * @param deflate - the zip entry's deflate stream.
 * @param content - the artifact text verbatim.
 * @param controller - response queue controller.
 * @param capacity - pull-driven response-capacity gate.
 * @param signal - cancellation; throws when aborted.
 */
async function pushArtifactChunks(
  deflate: ZipDeflate,
  content: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  capacity: ResponseCapacityGate,
  signal: AbortSignal,
): Promise<void> {
  const encoder = new TextEncoder()
  let offset = 0
  let finalChunk: boolean
  do {
    signal.throwIfAborted()
    let end = Math.min(offset + PUSH_CHUNK_CODE_UNITS, content.length)
    if (end < content.length && end - offset > 1) {
      // Back off one code unit when the boundary lands inside a surrogate
      // pair: the pair then starts the next chunk whole.
      const last = content.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) end -= 1
    }
    finalChunk = end >= content.length
    deflate.push(encoder.encode(content.slice(offset, end)), finalChunk)
    offset = end
    await capacity.wait(controller, signal)
  } while (!finalChunk)
}

/**
 * Stream one session-log ZIP as a WHATWG ReadableStream. The root artifact is
 * read and validated by the caller before this is called (missing root or
 * missing services answer cleanly before any byte is produced); each entry is
 * then encoded and deflated in bounded chunks as it is produced, so the
 * archive bytes arrive incrementally. A descendant or attachment that fails to
 * read errors the stream (fail-loud, never silent under-export).
 * @param deps - the mounted export services (the caller answered 500 before this runs).
 * @param root - the already-read root artifact (first zip entry).
 * @param sessionId - the root session id.
 * @param includeDescendants - whether to include every subagent descendant.
 * @param compressionLevel - validated fflate DEFLATE level for every ZIP entry.
 * @param signal - request cancellation combined with response-consumer cancellation.
 * @returns the zip byte stream.
 */
export function streamSessionLogZip(
  deps: SessionLogExportReady,
  root: SessionRawArtifact,
  sessionId: SessionId,
  includeDescendants: boolean,
  compressionLevel: SessionLogCompressionLevel,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const consumerAbort = new AbortController()
  const producerSignal = AbortSignal.any([signal, consumerAbort.signal])
  let zip: Zip | undefined
  let zipTerminated = false
  const capacity = new ResponseCapacityGate()
  const terminateZip = (): void => {
    if (zip === undefined || zipTerminated) return
    zipTerminated = true
    zip.terminate()
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // fflate invokes the callback synchronously per compressed chunk, so a
      // single push can enqueue ahead of a slow consumer; the capacity gate
      // waits for pull between pushes once the byte queue is full, bounding
      // accumulation to the queue high-water mark plus one synchronous push.
      const archive = new Zip((error, data, final) => {
        /* v8 ignore next 3 -- fflate reports only internal zip failures, unreachable for valid inputs */
        if (error) {
          controller.error(error)
          return
        }
        /* v8 ignore next -- fflate may emit empty chunks; not controllable from tests */
        if (data.byteLength > 0) controller.enqueue(data)
        if (final) controller.close()
      })
      zip = archive
      void (async () => {
        try {
          for await (const entry of sessionLogZipEntries(deps, root, sessionId, includeDescendants, producerSignal)) {
            const deflate = new ZipDeflate(entry.path, { level: compressionLevel })
            archive.add(deflate)
            if ('content' in entry) {
              await pushArtifactChunks(deflate, entry.content, controller, capacity, producerSignal)
            } else {
              await pushBinaryChunks(deflate, entry.data, controller, capacity, producerSignal)
            }
          }
          archive.end()
        } catch (error) {
          console.error('apiproxy: session export producer failed', error)
          // A mid-stream failure (missing descendant, cancellation, read
          // error) must fail the download rather than ship a truncated archive.
          /* v8 ignore next -- typed backends reject with Error, and DOMException is one in Node */
          terminateZip()
          controller.error(error instanceof Error ? error : new Error(String(error)))
        }
      })()
    },
    pull() {
      capacity.pulled()
    },
    cancel(reason) {
      consumerAbort.abort(
        reason instanceof Error ? reason : new Error('session log export stream cancelled'),
      )
      terminateZip()
    },
  }, {
    highWaterMark: RESPONSE_HIGH_WATER_MARK_BYTES,
    size: chunk => chunk.byteLength,
  })
}
