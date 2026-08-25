import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  CallId,
  contentHasDocument,
  createUserMessage,
  projectRequestDocumentsWithAttachments,
} from '../src/index.ts'
import type { ContentBlock } from '../src/index.ts'

const source = { kind: 'plugin' as const, plugin: 'test' }

function fileRef(id: string, mediaType: string, bytes: number, name: string): FileAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${id.repeat(64).slice(0, 64)}`),
    mediaType,
    bytes,
    name,
  }
}

function imageRef(): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${'d'.repeat(64)}`),
    mediaType: 'image/png',
    bytes: 4,
    width: 2,
    height: 2,
    name: 'figure.png',
  }
}

function parsedDocument(markdownBytes: number, images: ImageAttachmentRef[] = []): ContentBlock {
  return {
    type: 'document',
    attachment: {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'application/pdf',
      bytes: 5,
      name: 'report.pdf',
    },
    parsed: {
      parser: 'mineru',
      markdown: fileRef('b', 'text/markdown', markdownBytes, 'report.pdf.md'),
      contentList: fileRef('c', 'application/json', 2, 'report.pdf_content_list.json'),
      images,
    },
  }
}

function attachmentReader(markdown: Uint8Array): {
  readonly store: AttachmentStore
  readonly readFile: ReturnType<typeof vi.fn>
} {
  const readFile = vi.fn((ref: FileAttachmentRef) => Promise.resolve({ ref, data: markdown }))
  return { readFile, store: { readFile } as unknown as AttachmentStore }
}

describe('parsed document request projection', () => {
  it('resolves complete durable Markdown without injecting retained extracted images', async () => {
    const markdown = new TextEncoder().encode('# Heading\n\nComplete body.')
    const block = parsedDocument(markdown.byteLength, [imageRef()])
    const durable = createUserMessage({ content: [{ type: 'text', text: 'summarize: ' }, block], source })
    const attachments = attachmentReader(markdown)

    expect(contentHasDocument(durable.content)).toBe(true)
    const projected = await projectRequestDocumentsWithAttachments([durable], attachments.store)

    expect(projected).toHaveLength(1)
    expect(projected[0]?.content).toEqual([
      { type: 'text', text: 'summarize: ' },
      {
        type: 'text',
        text: '[attached document: report.pdf (application/pdf); parsed contents follow]\n\n# Heading\n\nComplete body.\n\n[end attached document: report.pdf]',
      },
    ])
    expect(durable.content[1]).toEqual(block)
    expect(attachments.readFile).toHaveBeenCalledTimes(1)
  })

  it('projects nested complete Markdown and leaves extracted image refs only in durable history', async () => {
    const markdown = new TextEncoder().encode('table body')
    const block = parsedDocument(markdown.byteLength, [imageRef()])
    const durable = createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: CallId('read-document'),
        content: [{ type: 'text', text: 'before\n' }, block],
      }],
      source,
    })

    const projected = await projectRequestDocumentsWithAttachments([durable], attachmentReader(markdown).store)
    expect(projected[0]?.content).toEqual([{
      type: 'tool-result',
      toolCallId: CallId('read-document'),
      content: [
        { type: 'text', text: 'before\n' },
        {
          type: 'text',
          text: '[attached document: report.pdf (application/pdf); parsed contents follow]\n\ntable body\n\n[end attached document: report.pdf]',
        },
      ],
    }])
    expect(durable.content[0]).toMatchObject({ type: 'tool-result', content: [{ type: 'text', text: 'before\n' }, block] })
  })
})
