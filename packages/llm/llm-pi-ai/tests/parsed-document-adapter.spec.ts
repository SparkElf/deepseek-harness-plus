import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* drain */ }
}

afterEach(async () => {
  await closeMockServers()
})

describe('pi-ai parsed document projection', () => {
  it('resolves durable Markdown before provider context conversion', async () => {
    const server = await mockServer([{ events: textEvents }])
    const markdown = new TextEncoder().encode('# Parsed\n\nComplete document body.')
    const markdownRef: FileAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
      mediaType: 'text/markdown',
      bytes: markdown.byteLength,
      name: 'report.pdf.md',
    }
    const readFile = vi.fn((ref: FileAttachmentRef) => Promise.resolve({ ref, data: markdown }))
    const attachments = { readFile } as unknown as AttachmentStore
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({
        deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: server.url },
      }),
      resolveApiKey: () => Promise.resolve('test-key'),
      resolveAttachments: () => attachments,
    })
    const originalId = AttachmentId(`sha256:${'a'.repeat(64)}`)

    await drain(adapter.stream({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{
          type: 'document',
          attachment: {
            attachmentId: originalId,
            mediaType: 'application/pdf',
            bytes: 5,
            name: 'report.pdf',
          },
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
