import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const TEST_USER_ID = '00000000-0000-4000-8000-000000000001' as AnonymousUserId

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* drain */ }
}

afterEach(async () => {
  await closeMockServers()
})

describe('DeepSeek parsed document projection', () => {
  it('resolves durable Markdown before provider serialization', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const markdown = new TextEncoder().encode('# Parsed\n\nComplete document body.')
    const markdownRef: FileAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
      mediaType: 'text/markdown',
      bytes: markdown.byteLength,
      name: 'report.pdf.md',
    }
    const readFile = vi.fn((ref: FileAttachmentRef) => Promise.resolve({ ref, data: markdown }))
    const attachments = { readFile } as unknown as AttachmentStore
    const adapter = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({ baseURL: server.url }),
      resolveApiKey: () => Promise.resolve('test-key'),
      resolveUserId: () => TEST_USER_ID,
      resolveAttachments: () => attachments,
    })
    const originalId = AttachmentId(`sha256:${'a'.repeat(64)}`)

    await drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{
          type: 'document',
          attachment: {
            attachmentId: originalId,
            mediaType: 'application/pdf',
            bytes: 5,
            name: 'report.pdf',
            parsed: {
              parser: 'mineru',
              markdown: markdownRef,
              contentList: {
                attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`),
                mediaType: 'application/json',
                bytes: 2,
                name: 'report.pdf_content_list.json',
              },
              images: [],
            },
          },
        }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))

    expect(readFile).toHaveBeenCalledWith(markdownRef, undefined)
    expect(server.requests[0]).toMatchObject({
      messages: [{
        role: 'user',
        content: '[attached document: report.pdf (application/pdf); parsed contents follow]\n\n# Parsed\n\nComplete document body.\n\n[end attached document: report.pdf]',
      }],
    })
    expect(JSON.stringify(server.requests[0])).not.toContain(String(originalId))
    expect(JSON.stringify(server.requests[0])).not.toContain(String(markdownRef.attachmentId))
  })
})
