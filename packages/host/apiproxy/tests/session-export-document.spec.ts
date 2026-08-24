import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { DocumentAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRawArtifact } from '@deepseek-ai/dsh-session-persistence'
import { sessionLogZipEntries, type SessionLogExportReady } from '../src/session-export.ts'

const sid = (value: string): SessionId => value as SessionId

describe('session export generic documents', () => {
  it('exports every DocumentBlock original through the verified generic file read path', async () => {
    const attachment: DocumentAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'application/pdf',
      bytes: 5,
      name: 'report.pdf',
    }
    const documentBytes = Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d)
    const event = {
      type: 'user/message',
      seq: 0,
      time: 1,
      data: { content: [{ type: 'document', attachment }] },
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
    const readFile = vi.fn(async (ref: DocumentAttachmentRef, signal?: AbortSignal) => ({
      ref,
      data: documentBytes,
      signal,
    }))
    const deps = {
      sessionQuery: {} as never,
      sessionPersistence: {} as never,
      sessions: undefined,
      attachments: {
        readImage: vi.fn(),
        readFile: async (ref: DocumentAttachmentRef, signal?: AbortSignal) => {
          const stored = await readFile(ref, signal)
          return { ref: stored.ref, data: stored.data }
        },
      } as never,
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
      {
        path: `documents/${String(attachment.attachmentId)}.pdf`,
        data: documentBytes,
      },
    ])
    expect(readFile).toHaveBeenCalledWith(attachment, controller.signal)
  })
})
