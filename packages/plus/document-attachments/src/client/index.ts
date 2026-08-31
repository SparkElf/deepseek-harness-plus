/** Browser Document prompt transport, localized intake validation, and nested card registrations. */

import { createElement } from 'react'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentIdType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { DocumentDraft, DocumentLimits } from './types.ts'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-trajectory/client'
import type {} from '@deepseek-ai/dsh-client-ui-attachment/client'
import type {} from 'dsh-better-sidebar/client/api'
import { DraftDocuments } from './DraftDocuments.tsx'
import { MessageDocuments, TrajectoryDocuments } from './MessageDocuments.tsx'
import type { OpenDocumentPreview } from './MessageDocuments.tsx'
import { SidebarDocumentPreview } from './SidebarDocumentPreview.tsx'
import { en, zh } from './locales.ts'

export const name = 'document-attachments-client'
export const inject = ['locale', 'slots', 'sessions', 'betterSidebar']
const NS = 'documentAttachments'
const PATH = '/api/document.prompt'
const PREVIEW_TAB = 'document-attachment'

interface DocumentPromptRequest {
  readonly sessionId: SessionId
  readonly requestId: SessionRequestId
  readonly mode: 'queue' | 'steer'
  readonly content: readonly unknown[]
  readonly signal?: AbortSignal
}
type DocumentPromptResponse =
  | { readonly ok: true; readonly value: { readonly accepted: true } }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: Record<string, unknown> } }

function browserHostUrl(path: string): string {
  return new URL(path.replace(/^[/]/u, ''), document.baseURI).toString()
}
function extension(mediaType: string): string {
  switch (mediaType) {
    case 'application/pdf': return '.pdf'
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return '.docx'
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation': return '.pptx'
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return '.xlsx'
    default: return ''
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function parsePromptResponse(value: unknown): DocumentPromptResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean') throw new Error('Document prompt response is invalid.')
  if (value.ok) {
    if (!isRecord(value.value) || value.value.accepted !== true) throw new Error('Document prompt success response is invalid.')
    return { ok: true, value: { accepted: true } }
  }
  if (!isRecord(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string' || !isRecord(value.error.details)) {
    throw new Error('Document prompt failure response is invalid.')
  }
  return { ok: false, error: { code: value.error.code, message: value.error.message, details: value.error.details } }
}
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.floor(bytes / (1024 * 1024))} MiB`
  return `${Math.floor(bytes / 1024)} KiB`
}

/** Localized Document intake and authenticated prompt transport consumed by Conversation. */
export interface DocumentPromptClient {
  /**
   * Return the localized rejection for slash-command submissions carrying Documents.
   * @returns localized rejection text for slash-command submissions.
   */
  commandUnsupported(): string
  /**
   * Format the browser drop target from the Host-projected limits.
   * @param limits - actual Host Document limits.
   * @returns localized mixed file drop invitation.
   */
  dropLabels(limits: DocumentLimits): { readonly title: string; readonly desc: string }
  /**
   * Validate a proposed browser Document intake before upload.
   * @param files - newly selected browser Documents.
   * @param existing - live Document drafts already registered.
   * @param limits - actual Host attachment-provider limits.
   * @returns localized rejection text, or null when intake may proceed.
   */
  validateIntake(
    files: readonly File[],
    existing: readonly DocumentDraft[],
    limits: DocumentLimits,
  ): string | null
  /**
   * Submit one prepared mixed prompt through the authenticated Host route.
   * @param request - prepared mixed browser prompt.
   * @returns Session-compatible prompt admission result.
   */
  submit(request: DocumentPromptRequest): Promise<DocumentPromptResponse>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser Document intake and prompt transport. */
    documentPrompt: DocumentPromptClient
  }
}

class DocumentPromptClientService extends Service implements DocumentPromptClient {
  constructor(ctx: Context) { super(ctx, 'documentPrompt') }

  commandUnsupported(): string { return this.ctx.locale.bind(NS)('command.unsupported') }

  dropLabels(limits: DocumentLimits): { readonly title: string; readonly desc: string } {
    const t = this.ctx.locale.bind(NS)
    return {
      title: t('drop.title'),
      desc: t('drop.desc', { count: limits.maxDocumentsPerMessage, size: formatBytes(limits.maxDocumentBytes) }),
    }
  }

  validateIntake(
    files: readonly File[],
    existing: readonly DocumentDraft[],
    limits: DocumentLimits,
  ): string | null {
    const t = this.ctx.locale.bind(NS)
    if (existing.length + files.length > limits.maxDocumentsPerMessage) {
      return t('intake.count', { count: limits.maxDocumentsPerMessage })
    }
    let total = existing.reduce((sum, document) => sum + document.file.size, 0)
    for (const file of files) {
      const expectedExtension = extension(file.type)
      if (!limits.mediaTypes.includes(file.type) || expectedExtension === '' || !file.name.toLowerCase().endsWith(expectedExtension)) {
        return t('intake.type')
      }
      if (file.size > limits.maxDocumentBytes) return t('intake.fileSize', { size: formatBytes(limits.maxDocumentBytes) })
      total += file.size
    }
    if (total > limits.maxMessageDocumentBytes) {
      return t('intake.totalSize', { size: formatBytes(limits.maxMessageDocumentBytes) })
    }
    return null
  }

  async submit(request: DocumentPromptRequest): Promise<DocumentPromptResponse> {
    try {
      const response = await fetch(browserHostUrl(PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: request.sessionId,
          requestId: request.requestId,
          mode: request.mode === 'steer' ? 'steer' : 'followup',
          content: request.content,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      const value = parsePromptResponse(await response.json() as unknown)
      if (!response.ok || !value.ok) {
        return value.ok
          ? { ok: false, error: { code: 'DOCUMENT_PROMPT_FAILED', message: this.ctx.locale.bind(NS)('submit.failed'), details: {} } }
          : value
      }
      return { ok: true, value: { accepted: true } }
    } catch (error) {
      console.error('document-attachments: client prompt failed', error)
      throw error
    }
  }
}

/** Install browser transport, localized validation, and Document card contributions. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'document-attachments: client dictionaries')
  new DocumentPromptClientService(ctx)
  /** Resolve one parser Markdown object through the owning Session's authorization check. */
  const readDocumentPreview = async (sessionId: SessionId, attachmentId: AttachmentIdType): Promise<string> => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error('document-attachments: preview session binding is unavailable')
    const result = await binding.session.readAttachment(attachmentId)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return new TextDecoder('utf-8', { fatal: true }).decode(result.value.data)
  }
  const openDocument: OpenDocumentPreview = (document, sessionId) => {
    ctx.betterSidebar.openTab({
      type: PREVIEW_TAB,
      id: `${PREVIEW_TAB}:${document.previewAttachmentId}:${document.name}`,
      title: document.name,
      path: document.previewAttachmentId,
    }, { sessionId })
  }
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: PREVIEW_TAB,
    title: () => ctx.locale.bind(NS)('preview.title'),
    hidden: true,
    component: props => createElement(SidebarDocumentPreview, {
      attachmentId: props.tab.path as AttachmentIdType,
      sessionId: props.scope.sessionId as SessionId,
      load: readDocumentPreview,
      t: ctx.locale.bind(NS),
    }),
  }), 'document-attachments: Better Sidebar preview tab')
  ctx.slots.inject('conversation.input.attachments.documents', () => ctx.slots.register({
    name: 'conversation.input.attachments.documents',
    locale: NS,
  }, DraftDocuments))
  ctx.slots.inject('conversation.message.images.documents', () => ctx.slots.register({
    name: 'conversation.message.images.documents',
    locale: NS,
  }, props => createElement(MessageDocuments, { ...props, onOpenDocument: openDocument })))
  ctx.slots.inject('conversation.trajectory.images.documents', () => ctx.slots.register({
    name: 'conversation.trajectory.images.documents',
    locale: NS,
  }, props => createElement(TrajectoryDocuments, { ...props, onOpenDocument: openDocument })))
}
