import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { toPiContext } from '../src/context.ts'

const document: ContentBlock = {
  type: 'document',
  attachment: {
    attachmentId: AttachmentId(`sha256:${'e'.repeat(64)}`),
    mediaType: 'application/pdf',
    bytes: 5,
    name: 'report.pdf',
  },
}

const marker = '[attached document: report.pdf (application/pdf); the document is stored, but its contents have not been parsed and are not available to the model yet.]'

function request(content: ContentBlock[]): GenerateOptions {
  return {
    provider: 'openai',
    model: 'gpt-4.1',
    messages: [createUserMessage({ content, source: { kind: 'plugin', plugin: 'test' } })],
  }
}

describe('pi-ai generic document projection', () => {
  it('projects documents before text-only context flattening', () => {
    const context = toPiContext(request([{ type: 'text', text: 'review: ' }, document]))
    expect(context.messages).toEqual([{
      role: 'user',
      content: `review: ${marker}`,
      timestamp: 0,
    }])
    expect(JSON.stringify(context)).not.toContain(String((document as Extract<ContentBlock, { type: 'document' }>).attachment.attachmentId))
  })

  it('projects nested tool-result documents recursively', () => {
    const callId = CallId('document-tool')
    const context = toPiContext(request([{
      type: 'tool-result',
      toolCallId: callId,
      content: [document],
    }]))
    expect(context.messages).toEqual([{
      role: 'toolResult',
      toolCallId: 'document-tool',
      toolName: 'unknown',
      content: [{ type: 'text', text: marker }],
      isError: false,
      timestamp: 0,
    }])
  })
})
