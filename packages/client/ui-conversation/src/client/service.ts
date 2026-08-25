/**
 * Scope-addressed conversation send, cancel, and history orchestration.
 *
 * Scope addressing rides the cordis Service tracker: property access through
 * `ctx.conversation` rebinds `this.ctx` to the caller's context, so methods
 * read the session tag with `scopeOf`. Mutable state must remain reachable
 * through one property read; assignment through the tracker proxy and `#`
 * private fields bypass that rebinding.
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports: a plugin-to-plugin value import is a bundle purity
// error, so scope resolution goes through the sessions service (scopeOf
// method) instead of the standalone helper.
import type { ISessions, SessionFace, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SubmitImageAttachment, SubmitOutcome } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {
  DocumentMediaType, ImageAttachmentRef, ImageMediaType,
} from '@deepseek-ai/dsh-attachment'
import type { ComposerAttachment } from './contract/slots.ts'
import type { ComposerDocumentAttachment } from './document-attachments.ts'
import type { QueueAction, QueueItemId } from './contract/queue.ts'
import type { ComposerBlocks } from './input/blocks.ts'
import type { DraftAttachmentId, SessionInputResolver } from './input/contract.ts'
import type { InputSubmitMode } from './contract/composer-submission.ts'

/**
 * The outward conversation face (`ctx.conversation`): the scope-addressed
 * verbs and the input registry other plugins may reach — and exactly what a
 * test fake must supply.
 */
export interface IConversation {
  /** The per-session input machine registry (SessionInputResolver face). */
  readonly input: SessionInputResolver
  /**
   * The per-session composer-block registry: how a plugin the composer
   * cannot import makes a session's input inert with its own reason.
   */
  readonly blocks: ComposerBlocks
  /**
   * Send a prompt into the caller scope's session (queued turn).
   * @param text - prompt text, sent verbatim as one text block.
   * @returns completion; business failures reject (and land in promptError).
   */
  send(text: string): Promise<void>
  /**
   * Apply one edit, remove, or strict steer operation to a pending queue occurrence.
   * @param itemId - agent-owned inbox occurrence identity.
   * @param action - requested queue operation.
   * @returns completion; converged strict-steer races resolve, while other failures reject.
   */
  updateQueue(itemId: QueueItemId, action: QueueAction): Promise<void>
  /**
   * Cancel the scoped session's in-flight turn while preserving its pending Queue.
   * @returns completion; failures reject as in send.
   */
  cancel(): Promise<void>
  /**
   * Pull one older history page for the scoped session.
   * @returns completion of the page pull.
   */
  loadOlder(): Promise<void>
}

/** Runtime-only draft attachment union; only its opaque id enters input state. */
type BrowserDraftAttachment = ComposerAttachment | ComposerDocumentAttachment

/** Create one browser-only image descriptor and preview URL. */
function browserDraftImage(file: File): ComposerAttachment {
  return {
    kind: 'image',
    id: crypto.randomUUID() as DraftAttachmentId,
    previewUrl: URL.createObjectURL(file),
    file,
  }
}

/** Create one browser-only document descriptor; documents need no object URL. */
function browserDraftDocument(file: File): ComposerDocumentAttachment {
  return {
    kind: 'document',
    id: crypto.randomUUID() as DraftAttachmentId,
    file,
  }
}

interface ImageUrlEntry {
  readonly sessionId: SessionId
  readonly generation: number
  readonly pending: Promise<string>
}

/** Unsupported browser-declared image type, localized by the UI boundary. */
export class UnsupportedImageMediaTypeError extends Error {
  /** Browser-declared MIME value, possibly empty. */
  readonly mediaType: string

  /** @param mediaType - Browser-declared MIME value, possibly empty. */
  constructor(mediaType: string) {
    super(`unsupported image media type: ${mediaType || '(empty)'}`)
    this.name = 'UnsupportedImageMediaTypeError'
    this.mediaType = mediaType
  }
}

/** Unsupported browser-declared generic-document type, localized by the UI boundary. */
export class UnsupportedDocumentMediaTypeError extends Error {
  /** Browser-declared MIME value, possibly empty. */
  readonly mediaType: string

  /** @param mediaType - Browser-declared MIME value, possibly empty. */
  constructor(mediaType: string) {
    super(`unsupported document media type: ${mediaType || '(empty)'}`)
    this.name = 'UnsupportedDocumentMediaTypeError'
    this.mediaType = mediaType
  }
}

/** A generic document needs a filename because Host admission validates extension/MIME agreement. */
export class InvalidDocumentNameError extends Error {
  constructor() {
    super('document filename is required')
    this.name = 'InvalidDocumentNameError'
  }
}

/** Scope-addressed conversation service (root singleton, provided as `conversation`). */
export class ConversationController extends Service implements IConversation {
  /** The per-session input machine registry (SessionInputResolver face). */
  readonly input: SessionInputResolver
  /** The per-session composer-block registry. */
  readonly blocks: ComposerBlocks
  private readonly draftAttachments = new Map<DraftAttachmentId, BrowserDraftAttachment>()
  private readonly imageUrls = new Map<string, ImageUrlEntry>()
  private readonly imageGenerations = new Map<SessionId, number>()
  private readonly createdImageUrls = new Set<string>()
  private disposed = false

  /**
   * @param ctx - owning root context (the plugin apply context; the service
   * registers itself and follows that fiber's lifetime).
   * @param config - carries the SessionInputResolver and composer-block registry
   * constructed by the plugin apply (the same instances the slot inject
   * factories close over).
   */
  constructor(ctx: Context, config: { input: SessionInputResolver; blocks: ComposerBlocks }) {
    super(ctx, 'conversation')
    this.input = config.input
    this.blocks = config.blocks
    ctx.effect(() => () => {
      this.disposed = true
      for (const url of this.createdImageUrls) revokePreview(url)
      this.createdImageUrls.clear()
      this.draftAttachments.clear()
      this.imageUrls.clear()
      this.imageGenerations.clear()
    }, 'conversation attachment URL cache')
  }

  /**
   * Send a prompt into the scoped session. Business failures also land in the
   * session snapshot's promptError (object-layer state); the rejection here
   * exists for caller choreography (the composer restores the draft on it).
   * @param text - prompt text, sent verbatim as one text block.
   */
  async send(text: string): Promise<void> {
    const session = this.scopedSession('send')
    const result = await session.prompt([{ type: 'text', text }], 'queue')
    if (!result.ok) throw new Error(`conversation.send failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Submit ordered browser draft attachments with text through one Host
   * admission. Images and documents share the same draft-id list so their
   * relative order is preserved without changing the input machine.
   * @param session - target session.
   * @param text - serialized prompt text.
   * @param attachmentIds - ordered draft-local attachment ids.
   * @param mode - queue or steer delivery selected by composer policy.
   * @param signal - optional cancellation for the complete Host admission.
   * @returns the Host admission outcome; local attachment preparation failures reject.
   */
  async sendSession(
    session: SessionFace,
    text: string,
    attachmentIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal?: AbortSignal,
  ): Promise<SubmitOutcome> {
    const attachments = this.draftAttachmentList(attachmentIds)
    const uploaded = await Promise.all(attachments.map(attachment => this.serializeAttachment(attachment)))
    const content = [...uploaded, ...(text === '' ? [] : [{ type: 'text' as const, text }])]
    const result = await session.prompt(content, mode, signal)
    if (!result.ok) return { kind: 'error' }
    this.releaseDraftAttachments(attachments)
    return { kind: 'success' }
  }

  /**
   * Create runtime-only draft images and their object URLs.
   * @param files - browser files to register after MIME validation.
   * @returns ordered draft descriptors.
   */
  createDraftImages(files: readonly File[]): readonly ComposerAttachment[] {
    for (const file of files) imageMediaType(file.type)
    return files.map((file) => {
      const attachment = browserDraftImage(file)
      this.draftAttachments.set(attachment.id, attachment)
      this.createdImageUrls.add(attachment.previewUrl)
      return attachment
    })
  }

  /**
   * Register supported generic documents without creating object URLs.
   * @param files - browser files to validate and register as document drafts.
   * @returns ordered runtime-only document descriptors.
   */
  createDraftDocuments(files: readonly File[]): readonly ComposerDocumentAttachment[] {
    for (const file of files) {
      documentMediaType(file.type)
      if (file.name.trim() === '') throw new InvalidDocumentNameError()
    }
    return files.map((file) => {
      const attachment = browserDraftDocument(file)
      this.draftAttachments.set(attachment.id, attachment)
      return attachment
    })
  }

  /**
   * Resolve ordered input-state ids to runtime-owned draft images only.
   * @param ids - opaque mixed attachment ids in input-state order.
   * @returns the live image descriptors among those ids, preserving their order.
   */
  draftImages(ids: readonly DraftAttachmentId[]): readonly ComposerAttachment[] {
    const attachments: ComposerAttachment[] = []
    for (const id of ids) {
      const attachment = this.draftAttachments.get(id)
      if (attachment?.kind === 'image') attachments.push(attachment)
    }
    return attachments
  }

  /**
   * Resolve ordered input-state ids to runtime-owned draft documents only.
   * @param ids - opaque mixed attachment ids in input-state order.
   * @returns the live document descriptors among those ids, preserving their order.
   */
  draftDocuments(ids: readonly DraftAttachmentId[]): readonly ComposerDocumentAttachment[] {
    const attachments: ComposerDocumentAttachment[] = []
    for (const id of ids) {
      const attachment = this.draftAttachments.get(id)
      if (attachment?.kind === 'document') attachments.push(attachment)
    }
    return attachments
  }

  /**
   * Serialize ordered draft images to command-submit wire payloads without
   * sending or releasing them. Generic documents are deliberately rejected:
   * the command attachment envelope remains image-only.
   * @param imageIds - opaque attachment ids that must all resolve to images.
   * @returns command-wire image payloads in the same order as the supplied ids.
   */
  async serializeDraftImages(imageIds: readonly DraftAttachmentId[]): Promise<readonly SubmitImageAttachment[]> {
    const attachments = this.draftImages(imageIds)
    if (attachments.length !== imageIds.length) {
      throw new Error('slash commands do not accept document attachments')
    }
    return Promise.all(attachments.map(attachment => this.encodeImage(attachment.file)))
  }

  /**
   * Release one browser-owned draft attachment, revoking image URLs only.
   * @param id - opaque draft attachment id to remove from the runtime registry.
   */
  releaseDraftAttachment(id: DraftAttachmentId): void {
    const attachment = this.draftAttachments.get(id)
    if (attachment === undefined) return
    this.draftAttachments.delete(id)
    if (attachment.kind === 'image') {
      this.createdImageUrls.delete(attachment.previewUrl)
      revokePreview(attachment.previewUrl)
    }
  }

  /**
   * Backward-compatible image-specific release used by current image callers.
   * @param id - opaque draft image id to release.
   */
  releaseDraftImage(id: DraftAttachmentId): void {
    this.releaseDraftAttachment(id)
  }

  /**
   * Document-specific release used by the mixed attachment rail.
   * @param id - opaque draft document id to release.
   */
  releaseDraftDocument(id: DraftAttachmentId): void {
    this.releaseDraftAttachment(id)
  }

  /**
   * Release a set of browser-owned draft images.
   * @param attachments - image descriptors whose ids should be released.
   */
  releaseDraftImages(attachments: readonly ComposerAttachment[]): void {
    for (const attachment of attachments) this.releaseDraftAttachment(attachment.id)
  }

  /**
   * Release any set of browser-owned draft attachments.
   * @param attachments - mixed image/document descriptors whose ids should be released.
   */
  releaseDraftAttachments(attachments: readonly BrowserDraftAttachment[]): void {
    for (const attachment of attachments) this.releaseDraftAttachment(attachment.id)
  }

  /**
   * Resolve and cache one session-authorized historical image URL.
   * @param sessionId - owning session authorization scope.
   * @param attachment - durable image reference.
   * @returns browser URL valid until its rendered session is released.
   */
  resolveImage(sessionId: SessionId, attachment: ImageAttachmentRef): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('conversation.resolveImage: service is disposed'))
    const key = `${sessionId}:${attachment.attachmentId}`
    const cached = this.imageUrls.get(key)
    if (cached !== undefined) return cached.pending
    const generation = this.imageGenerations.get(sessionId) ?? 0
    const session = this.requireSessions().binding(sessionId)?.session
    if (session === undefined) {
      return Promise.reject(new Error(`conversation.resolveImage: unknown session "${sessionId}"`))
    }
    const pending = session.readAttachment(attachment.attachmentId)
      .then((result) => {
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        if (this.disposed) throw new Error('conversation.resolveImage: service was disposed before loading completed')
        if ((this.imageGenerations.get(sessionId) ?? 0) !== generation) {
          throw new Error('historical image scope was released before loading completed')
        }
        if (typeof URL.createObjectURL !== 'function') {
          return `data:${result.value.attachment.mediaType};base64,${bytesToBase64(result.value.data)}`
        }
        const bytes = Uint8Array.from(result.value.data)
        const url = URL.createObjectURL(new Blob([bytes.buffer], { type: result.value.attachment.mediaType }))
        this.createdImageUrls.add(url)
        return url
      })
      .catch((error: unknown) => {
        this.ctx.logger.error('conversation: historical image load failed')
        this.ctx.logger.error(error)
        if (this.imageUrls.get(key)?.generation === generation) this.imageUrls.delete(key)
        throw error
      })
    this.imageUrls.set(key, { sessionId, generation, pending })
    return pending
  }

  /**
   * Release every historical image URL owned by one rendered session.
   * @param sessionId - rendered session scope.
   */
  releaseSessionImages(sessionId: SessionId): void {
    this.imageGenerations.set(sessionId, (this.imageGenerations.get(sessionId) ?? 0) + 1)
    for (const [key, entry] of this.imageUrls) {
      if (entry.sessionId !== sessionId) continue
      this.imageUrls.delete(key)
      void entry.pending.then((url) => {
        if (!this.createdImageUrls.delete(url)) return
        revokePreview(url)
      }, () => {
        // A failed or invalidated load owns no object URL.
      })
    }
  }

  /** Apply one operation to a pending queue occurrence. */
  async updateQueue(itemId: QueueItemId, action: QueueAction): Promise<void> {
    const session = this.scopedSession('updateQueue')
    const result = await session.updateQueue(itemId, action)
    if (!result.ok) {
      if (
        action.kind === 'steer'
        && (result.error.code === 'steer-unavailable' || result.error.code === 'queue-item-not-found')
      ) return
      throw new Error(`conversation.updateQueue failed: ${result.error.code}: ${result.error.message}`)
    }
  }

  /** Cancel the scoped session's in-flight turn while preserving Queue (failures land in promptError and reject, as in send). */
  async cancel(): Promise<void> {
    const session = this.scopedSession('cancel')
    const result = await session.cancel()
    if (!result.ok) throw new Error(`conversation.cancel failed: ${result.error.code}: ${result.error.message}`)
  }

  /** Pull one older history page for the scoped Session. */
  async loadOlder(): Promise<void> {
    await this.scopedSession('loadOlder').loadOlder()
  }

  /** Resolve the caller scope's session face or throw on root contexts. */
  private scopedSession(op: string): SessionFace {
    const id = this.scopeId(op)
    const binding = this.requireSessions().binding(id)
    if (binding === undefined) throw new Error(`conversation.${op}: session "${id}" resolved no binding`)
    return binding.session
  }

  /** Read the caller's session scope tag via the sessions service; root contexts fail loud. */
  private scopeId(op: string): SessionId {
    const id = this.requireSessions().scopeOf(this.ctx)
    if (id === undefined) {
      throw new Error(`conversation.${op} requires a session scope — address one via ctx.sessions.scope(id).conversation`)
    }
    return id
  }

  private requireSessions(): ISessions {
    // Strict ctx.get, not the injection proxy: the scope-addressed pattern
    // reads the service off whatever context the tracker rebound.
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('conversation: sessions service unavailable')
    return sessions
  }

  /** Resolve every id to its generic draft record, preserving order. */
  private draftAttachmentList(ids: readonly DraftAttachmentId[]): BrowserDraftAttachment[] {
    // Input state retains only ids created and still owned by this registry.
    return ids.map(id => this.draftAttachments.get(id)!) // oxlint-disable-line typescript/no-non-null-assertion
  }

  /** Serialize one draft attachment into the host prompt wire. */
  private async serializeAttachment(
    attachment: BrowserDraftAttachment,
  ): Promise<Parameters<SessionFace['prompt']>[0][number]> {
    if (attachment.kind === 'image') {
      return { type: 'image', ...await this.encodeImage(attachment.file) }
    }
    return {
      type: 'document',
      mediaType: documentMediaType(attachment.file.type),
      data: bytesToBase64(new Uint8Array(await attachment.file.arrayBuffer())),
      name: attachment.file.name,
    }
  }

  /** Canonical base64 wire form of one browser image file. */
  private async encodeImage(file: File): Promise<SubmitImageAttachment> {
    return {
      mediaType: imageMediaType(file.type),
      data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
      ...(file.name === '' ? {} : { name: file.name }),
    }
  }
}

function imageMediaType(value: string): ImageMediaType {
  switch (value) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
    case 'image/gif':
      return value
    default:
      throw new UnsupportedImageMediaTypeError(value)
  }
}

function documentMediaType(value: string): DocumentMediaType {
  switch (value) {
    case 'application/pdf':
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return value
    default:
      throw new UnsupportedDocumentMediaTypeError(value)
  }
}

function bytesToBase64(data: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < data.length; offset += chunk) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

function revokePreview(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}
