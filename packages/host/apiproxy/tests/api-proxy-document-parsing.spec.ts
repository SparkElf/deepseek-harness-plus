import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AttachmentStore, {
  AttachmentId,
  type FileAttachmentRef,
  type ImageAttachmentRef,
  type SaveFileAttachment,
} from '@deepseek-ai/dsh-attachment'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { DocumentParserError } from '@deepseek-ai/dsh-document-parser'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`document-parse-${String(nextRpc++)}`), payload }
}

interface Harness {
  ctx: Context
  agent: Agent
  sessionId: SessionId
  followup: ReturnType<typeof vi.fn>
  saveFile: ReturnType<typeof vi.fn>
  readFile: ReturnType<typeof vi.fn>
  saveImage: ReturnType<typeof vi.fn>
}

async function harness(options: {
  maxDirectMarkdownBytes?: number
  parse?: (data: Uint8Array) => Promise<{
    parser: string
    result: { markdown: Uint8Array; contentList: Uint8Array; images: Array<{ name: string; mediaType: 'image/png'; data: Uint8Array }> }
  }>
} = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)

  let nextAttachment = 1
  const files = new Map<string, { ref: FileAttachmentRef; data: Uint8Array }>()
  const saveFile = vi.fn(async (input: SaveFileAttachment): Promise<FileAttachmentRef> => {
    const ref: FileAttachmentRef = {
      attachmentId: AttachmentId(`test-${String(nextAttachment++)}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      ...(input.name === undefined ? {} : { name: input.name }),
    }
    files.set(String(ref.attachmentId), { ref, data: input.data })
    return ref
  })
  const readFile = vi.fn(async (ref: FileAttachmentRef) => {
    const stored = files.get(String(ref.attachmentId))
    if (stored === undefined) throw new Error(`missing ${String(ref.attachmentId)}`)
    return stored
  })
  const saveImage = vi.fn(async (input: { data: Uint8Array; mediaType: 'image/png'; name?: string }): Promise<ImageAttachmentRef> => ({
    attachmentId: AttachmentId(`image-${String(nextAttachment++)}`),
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
    width: 1,
    height: 1,
    ...(input.name === undefined ? {} : { name: input.name }),
  }))
  const attachments = {
    imageLimits: {
      maxImageBytes: 1024,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 2048,
      maxImagePixels: 4,
      maxImageDimension: 4,
      mediaTypes: ['image/png'],
    },
    documentLimits: {
      maxDocumentBytes: 1024,
      maxDocumentsPerMessage: 2,
      maxMessageDocumentBytes: 2048,
      mediaTypes: ['application/pdf'],
    },
    validateImage: () => Promise.resolve(),
    saveImage,
    saveImages(inputs: readonly { data: Uint8Array; mediaType: 'image/png'; name?: string }[]) {
      return AttachmentStore.prototype.saveImages.call(attachments, inputs)
    },
    saveFile,
    readFile,
  }
  ctx.provide('attachments', attachments as never)

  const parse = options.parse ?? (data => Promise.resolve({
    parser: 'mineru',
    result: {
      markdown: new TextEncoder().encode('# parsed'),
      contentList: new TextEncoder().encode('[{"type":"text"}]'),
      images: [{ name: 'figure.png', mediaType: 'image/png' as const, data: new Uint8Array([1]) }],
    },
  }))
  ctx.provide('documentParser', {
    maxDirectMarkdownBytes: options.maxDirectMarkdownBytes ?? 1024,
    parse: ({ data }: { data: Uint8Array }) => parse(data),
  } as never)

  const session = ctx.sessions.create()
  const followup = vi.fn()
  const agent = {
    id: session.id,
    session,
    status: 'running',
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
    followup,
  } as unknown as Agent
  ctx.agents.register(agent)
  return { ctx, agent, sessionId: session.id, followup, saveFile, readFile, saveImage }
}

function apiFor(ctx: Context) {
  return createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
    cwd: '/tmp',
  })
}

const pdf = Buffer.from('%PDF-').toString('base64')

describe('session.prompt document parsing admission', () => {
  it('persists parser outputs and appends only durable parsed references', async () => {
    const state = await harness()
    const response = await apiFor(state.ctx).sessions.prompt(request({
      sessionId: state.sessionId,
      mode: 'queue' as const,
      content: [
        { type: 'text' as const, text: 'summarize' },
        { type: 'document' as const, mediaType: 'application/pdf' as const, data: pdf, name: 'sample.pdf' },
      ],
    }))

    expect(response.result.ok).toBe(true)
    expect(state.readFile).toHaveBeenCalledTimes(1)
    expect(state.saveFile).toHaveBeenCalledTimes(3)
    expect(state.saveImage).toHaveBeenCalledTimes(1)
    const message = state.followup.mock.calls[0]?.[0] as UserMessage
    expect(message.content[0]).toEqual({ type: 'text', text: 'summarize' })
    expect(message.content[1]).toMatchObject({
      type: 'document',
      attachment: {
        mediaType: 'application/pdf',
        name: 'sample.pdf',
        parsed: {
          parser: 'mineru',
          markdown: { mediaType: 'text/markdown', name: 'sample.pdf.md' },
          contentList: { mediaType: 'application/json', name: 'sample.pdf_content_list.json' },
          images: [{ mediaType: 'image/png', name: 'figure.png' }],
        },
      },
    })
    expect(JSON.stringify(message)).not.toContain('# parsed')
    await state.ctx.fiber.dispose()
  })

  it('maps parser failure to attachment-error and appends no user message', async () => {
    const state = await harness({
      parse: () => Promise.reject(new DocumentParserError('parse failed', 'DOCUMENT_PARSE_FAILED')),
    })
    const response = await apiFor(state.ctx).sessions.prompt(request({
      sessionId: state.sessionId,
      mode: 'queue' as const,
      content: [{ type: 'document' as const, mediaType: 'application/pdf' as const, data: pdf, name: 'sample.pdf' }],
    }))

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'DOCUMENT_PARSE_FAILED' } },
    })
    expect(state.followup).not.toHaveBeenCalled()
    expect(state.saveFile).toHaveBeenCalledTimes(1)
    await state.ctx.fiber.dispose()
  })

  it('rejects over-budget complete Markdown before appending the user message', async () => {
    const markdown = new TextEncoder().encode('12345')
    const state = await harness({
      maxDirectMarkdownBytes: 4,
      parse: () => Promise.resolve({
        parser: 'mineru',
        result: { markdown, contentList: new TextEncoder().encode('[]'), images: [] },
      }),
    })
    const response = await apiFor(state.ctx).sessions.prompt(request({
      sessionId: state.sessionId,
      mode: 'queue' as const,
      content: [{ type: 'document' as const, mediaType: 'application/pdf' as const, data: pdf, name: 'sample.pdf' }],
    }))

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'DOCUMENT_PARSE_CONTEXT_TOO_LARGE' } },
    })
    expect(state.followup).not.toHaveBeenCalled()
    expect(state.saveFile).toHaveBeenCalledTimes(3)
    await state.ctx.fiber.dispose()
  })
})
