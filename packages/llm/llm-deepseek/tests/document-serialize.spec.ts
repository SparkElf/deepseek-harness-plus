import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { serializeMessages } from '../src/serialize.ts'

const document = {
  type: 'document' as const,
  attachment: {
    attachmentId: AttachmentId(`sha256:${'d'.repeat(64)}`),
    mediaType: 'application/pdf' as const,
    bytes: 5,
    name: 'report.pdf',
  },
}

const marker = '[attached document: report.pdf (application/pdf); the document is stored, but its contents have not been parsed and are not available to the model yet.]'

describe('DeepSeek generic document projection', () => {
  it('serializes an unparsed document as an explicit user-visible marker', () => {
    const wire = serializeMessages([createUserMessage({
      content: [{ type: 'text', text: 'review: ' }, document],
      source: { kind: 'plugin', plugin: 'test' },
    })])
    expect(wire).toEqual([{ role: 'user', content: `review: ${marker}` }])
    expect(JSON.stringify(wire)).not.toContain(String(document.attachment.attachmentId))
  })

  it('projects documents recursively inside tool results', () => {
    const wire = serializeMessages([createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: CallId('document-tool'),
        content: [document],
      }],
      source: { kind: 'plugin', plugin: 'test' },
    })])
    expect(wire).toEqual([{ role: 'tool', tool_call_id: 'document-tool', content: marker }])
  })
})
