import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  CallId,
  contentHasParsedDocument,
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

function parsedDocument(markdownBytes: number): ContentBlock {
  return {
    type: 'document',
    attachment: {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'application/pdf',
      bytes: 5,
      name: 'report.pdf',
      parsed: {
        parser: 'mineru',
        markdown: fileRef('b', 'text/markdown', markdownBytes, 'report.pdf.md'),
        contentList: fileRef('c', 'application/json', 2, 'report.pdf_content_list.json'),
        images: [],
      },
    },
  }
}

function unparsedDocument(): ContentBlock {
  return {
    type: 'document',
    attachment: {
      attachmentId: AttachmentId(`sha256:${'d'.repeat(64)}`),
      mediaType: 'application/pdf',
      bytes: 5,
      name: 'unparsed.pdf',
    },
  }
}

function attachmentReader(markdown: Uint8Array): AttachmentStore {
  return {
    readFile: vi.fn((ref: FileAttachmentRef) => Promise.resolve({ ref, data: markdown })),
  } as unknown as AttachmentStore
}

describe('parsed document request projection', () => {
  it('resolves complete durable Markdown into a delimited transient text block', async () => {
    const markdown = new TextEncoder().encode('# Heading\n\nComplete body.')
    const block = parsedDocument(markdown.byteLength)
    const durable = createUserMessage({ content: [{ type: 'text', text: 'summarize: ' }, block], source })
    const attachments = attachmentReader(markdown)

    expect(contentHasParsedDocument(durable.content)).toBe(true)
    const projected = await projectRequestDocumentsWithAttachments([durable], attachments)

    expect(projected).not.toBe([durable])
    expect(projected).toHaveLength(1)
    expect(projected[0]?.content).toEqual([
      { type: 'text', text: 'summarize: ' },
      {
        type: 'text',
        text: '[attached document: report.pdf (application/pdf); parsed contents follow]\n\n# Heading\n\nComplete body.\n\n[end attached document: report.pdf]',
      },
    ])
    expect(durable.content[1]).toEqual(block)
    expect((attachments.readFile as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
  })

  it('projects parsed documents recursively inside tool results', async () => {
    const markdown = new TextEncoder().encode('table body')
    const durable = createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: CallId('read-document'),
        content: [{ type: 'text', text: 'before\n' }, parsedDocument(markdown.byteLength)],
      }],
      source,
    })

    const projected = await projectRequestDocumentsWithAttachments([durable], attachmentReader(markdown))
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
  })

  it('keeps semantic honesty for an unparsed durable document', async () => {
    const attachments = attachmentReader(new Uint8Array())
    const durable = createUserMessage({ content: [unparsedDocument()], source })

    expect(contentHasParsedDocument(durable.content)).toBe(false)
    const projected = await projectRequestDocumentsWithAttachments([durable], attachments)
    expect(projected[0]?.content).toEqual([{
      type: 'text',
      text: '[attached document: unparsed.pdf (application/pdf); the document is stored, but its contents have not been parsed and are not available to the model yet.]',
    }])
    expect(attachments.readFile).not.toHaveBeenCalled()
  })

  it('rejects invalid UTF-8 parser Markdown instead of inserting replacement characters', async () => {
    const invalid = new Uint8Array([0xc3, 0x28])
    const durable = createUserMessage({ content: [parsedDocument(invalid.byteLength)], source })

    await expect(projectRequestDocumentsWithAttachments([durable], attachmentReader(invalid)))
      .rejects.toThrow('Parsed Markdown for document "report.pdf" is not valid UTF-8.')
  })
})
