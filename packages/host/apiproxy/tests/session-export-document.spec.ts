import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { DocumentAttachmentRef, FileAttachmentRef, ImageAttachmentRef, ParsedDocumentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRawArtifact } from '@deepseek-ai/dsh-session-persistence'
import { sessionLogZipEntries, type SessionLogExportReady } from '../src/session-export.ts'

const sid = (value: string): SessionId => value as SessionId
const attachmentId = (value: string) => AttachmentId(`sha256:${value.repeat(64)}`)

describe('session export parsed documents', () => {
  it('exports the original and every durable parsed object required by the DocumentBlock', async () => {
    const attachment: DocumentAttachmentRef = {
      attachmentId: attachmentId('a'),
      mediaType: 'application/pdf',
      bytes: 5,
      name: 'report.pdf',
    }
    const markdown: FileAttachmentRef = {
      attachmentId: attachmentId('b'),
      mediaType: 'text/markdown',
      bytes: 4,
      name: 'report.pdf.md',
    }
    const contentList: FileAttachmentRef = {
      attachmentId: attachmentId('c'),
      mediaType: 'application/json',
      bytes: 2,
      name: 'report.pdf_content_list.json',
    }
    const image: ImageAttachmentRef = {
      attachmentId: attachmentId('d'),
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
      name: 'figure.png',
    }
    const parsed: ParsedDocumentRef = { parser: 'mineru', markdown, contentList, images: [image] }
    const bytes = new Map([
      [String(attachment.attachmentId), Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d)],
      [String(markdown.attachmentId), new TextEncoder().encode('body')],
      [String(contentList.attachmentId), new TextEncoder().encode('[]')],
      [String(image.attachmentId), Uint8Array.of(0x89, 0x50, 0x4e, 0x47)],
    ])
    const event = {
      type: 'user/message',
      seq: 0,
      time: 1,
      data: { content: [{ type: 'document', attachment, parsed }] },
    }
    const root = {
      meta: {
        version: 0,
        id: sid('session-root'),
        createdAt: 1,
        cwd: '/proj',
        delegationDepth: 0,
      },
      filename: 'session.jsonl',
      content: `${JSON.stringify(event)}\n`,
    } as unknown as SessionRawArtifact
    const readFile = vi.fn(async (ref: FileAttachmentRef, _signal?: AbortSignal) => ({
      ref,
      data: bytes.get(String(ref.attachmentId))!,
    }))
    const readImage = vi.fn(async (ref: ImageAttachmentRef, _signal?: AbortSignal) => ({
      ref,
      data: bytes.get(String(ref.attachmentId))!,
    }))
    const deps = {
      sessionQuery: {} as never,
      sessionPersistence: {} as never,
      sessions: undefined,
      attachments: { readImage, readFile } as never,
    } satisfies SessionLogExportReady
    const controller = new AbortController()

    const entries = []
    for await (const entry of sessionLogZipEntries(
      deps,
      root,
      sid('session-root'),
      false,
      controller.signal,
    )) entries.push(entry)

    expect(entries).toEqual([
      { path: 'session.jsonl', content: root.content },
      { path: `media/${String(image.attachmentId)}.png`, data: bytes.get(String(image.attachmentId)) },
      { path: `documents/${String(attachment.attachmentId)}.pdf`, data: bytes.get(String(attachment.attachmentId)) },
      { path: `parsed/${String(markdown.attachmentId)}.md`, data: bytes.get(String(markdown.attachmentId)) },
      { path: `parsed/${String(contentList.attachmentId)}.json`, data: bytes.get(String(contentList.attachmentId)) },
    ])
    expect(readImage).toHaveBeenCalledWith(image, controller.signal)
    expect(readFile).toHaveBeenCalledWith(attachment, controller.signal)
    expect(readFile).toHaveBeenCalledWith(markdown, controller.signal)
    expect(readFile).toHaveBeenCalledWith(contentList, controller.signal)
  })
})
