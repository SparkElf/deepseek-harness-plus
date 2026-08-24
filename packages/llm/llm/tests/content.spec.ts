import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import {
  CallId, createUserMessage, OFFLOADED_IMAGE_TEXT, offloadRequestImages,
  projectRequestDocuments, projectUnparsedDocuments, unparsedDocumentText,
} from '../src/index.ts'
import type { ContentBlock } from '../src/index.ts'

const source = { kind: 'plugin' as const, plugin: 'test' }

function image(bytes: number): ContentBlock {
  return {
    type: 'image',
    attachment: {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes,
      width: 1,
      height: 1,
    },
  }
}

function document(name = 'report.pdf'): ContentBlock {
  return {
    type: 'document',
    attachment: {
      attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
      mediaType: 'application/pdf',
      bytes: 5,
      name,
    },
  }
}

describe('generic document request projection', () => {
  it('uses an explicit unparsed marker without exposing opaque attachment ids', () => {
    const block = document('evidence.pdf')
    if (block.type !== 'document') throw new Error('document fixture narrowed incorrectly')
    const text = unparsedDocumentText(block)
    expect(text).toContain('evidence.pdf')
    expect(text).toContain('application/pdf')
    expect(text).toContain('contents have not been parsed')
    expect(text).not.toContain(String(block.attachment.attachmentId))
  })

  it('projects nested documents without mutating durable content', () => {
    const nestedDocument = document()
    const durable: ContentBlock[] = [{
      type: 'tool-result',
      toolCallId: CallId('read'),
      content: [{ type: 'text', text: 'before' }, nestedDocument],
    }]

    const projected = projectUnparsedDocuments(durable)
    expect(projected).not.toBe(durable)
    expect(projected).toEqual([{
      type: 'tool-result',
      toolCallId: CallId('read'),
      content: [
        { type: 'text', text: 'before' },
        {
          type: 'text',
          text: '[attached document: report.pdf (application/pdf); the document is stored, but its contents have not been parsed and are not available to the model yet.]',
        },
      ],
    }])
    expect(durable[0]).toMatchObject({ type: 'tool-result', content: [{ type: 'text', text: 'before' }, nestedDocument] })
  })

  it('preserves message and array identity when no document needs projection', () => {
    const messages = [createUserMessage({ content: [{ type: 'text', text: 'unchanged' }], source })]
    expect(projectRequestDocuments(messages)).toBe(messages)
  })
})

describe('offloadRequestImages', () => {
  it('preserves the original request when its base64 payload fits exactly', () => {
    const messages = [createUserMessage({ content: [image(3), image(3)], source })]
    expect(offloadRequestImages(messages, 8)).toBe(messages)
  })

  it('keeps five 3 MiB images at 20 MiB and offloads the oldest after one more raw byte', () => {
    const rawImageBytes = 3 * 1024 * 1024
    const maxRequestImageBytes = 20 * 1024 * 1024
    const exact = [createUserMessage({
      content: Array.from({ length: 5 }, () => image(rawImageBytes)),
      source,
    })]
    expect(offloadRequestImages(exact, maxRequestImageBytes)).toBe(exact)

    const over = [createUserMessage({
      content: [image(rawImageBytes + 1), ...Array.from({ length: 4 }, () => image(rawImageBytes))],
      source,
    })]
    expect(offloadRequestImages(over, maxRequestImageBytes)[0]?.content).toEqual([
      { type: 'text', text: OFFLOADED_IMAGE_TEXT },
      ...Array.from({ length: 4 }, () => image(rawImageBytes)),
    ])
  })

  it('replaces the oldest nested occurrences without mutating durable messages', () => {
    const shared = image(3)
    const messages = [
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('shot'),
          content: [shared],
        }],
        source,
      }),
      createUserMessage({ content: [shared, image(3)], source }),
    ]

    const fitted = offloadRequestImages(messages, 8)
    expect(fitted).not.toBe(messages)
    expect(fitted[0]?.content).toEqual([{
      type: 'tool-result',
      toolCallId: CallId('shot'),
      content: [{ type: 'text', text: OFFLOADED_IMAGE_TEXT }],
    }])
    expect(fitted[1]?.content).toEqual([shared, image(3)])
    expect(messages[0]?.content[0]).toMatchObject({ type: 'tool-result', content: [shared] })
  })

  it('replaces a single image that cannot fit', () => {
    const messages = [createUserMessage({ content: [image(300)], source })]
    expect(offloadRequestImages(messages, 8)[0]?.content)
      .toEqual([{ type: 'text', text: OFFLOADED_IMAGE_TEXT }])
  })

  it('keeps unchanged nested content while replacing a later image', () => {
    const nested = {
      type: 'tool-result' as const,
      toolCallId: CallId('text-only'),
      content: [{ type: 'text' as const, text: 'kept' }],
    }
    const messages = [createUserMessage({ content: [nested, image(3)], source })]
    expect(offloadRequestImages(messages, 1)[0]?.content).toEqual([
      nested,
      { type: 'text', text: OFFLOADED_IMAGE_TEXT },
    ])
  })
})
