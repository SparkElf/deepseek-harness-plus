// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import { SlotTestRuntime, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'
import { InputHub } from '../src/client/input/hub.ts'
import {
  ConversationController, InvalidDocumentNameError, UnsupportedDocumentMediaTypeError,
} from '../src/client/service.ts'
import { zh } from '../src/client/locales.ts'

async function bench() {
  const runtime = await SlotTestRuntime.create()
  const prompt = vi.fn<SessionFace['prompt']>()
  prompt.mockResolvedValue({ ok: true, value: { accepted: true } })
  await runtime.sessions.add({
    id: 's1',
    session: {
      prompt,
      updateQueue: vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } })),
      cancel: vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } })),
      loadOlder: vi.fn(() => Promise.resolve()),
    },
  })
  const hub = new InputHub(runtime.ctx, makeTranslate(zh, {}))
  const fiber = runtime.ctx.plugin(ConversationController, {
    input: hub,
    blocks: new ComposerBlockRegistry(),
  })
  await fiber.await()
  const root = runtime.ctx.get('conversation') as ConversationController
  const session = runtime.sessions.binding('s1')!.session
  return { runtime, root, session, prompt }
}

describe('generic document browser lifecycle', () => {
  it('preserves mixed image/document order on prompt serialization and releases accepted drafts', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pixel')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const [image] = b.root.createDraftImages([
        new File([Uint8Array.of(1)], 'pixel.png', { type: 'image/png' }),
      ])
      const [document] = b.root.createDraftDocuments([
        new File([Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d)], 'report.pdf', { type: 'application/pdf' }),
      ])
      if (image === undefined || document === undefined) throw new Error('draft attachment missing')

      await expect(b.root.sendSession(
        b.session,
        'hello',
        [image.id, document.id],
        'queue',
      )).resolves.toEqual({ kind: 'success' })

      expect(b.prompt).toHaveBeenCalledWith([
        { type: 'image', mediaType: 'image/png', data: 'AQ==', name: 'pixel.png' },
        { type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=', name: 'report.pdf' },
        { type: 'text', text: 'hello' },
      ], 'queue', undefined)
      expect(b.root.draftImages([image.id])).toEqual([])
      expect(b.root.draftDocuments([document.id])).toEqual([])
      expect(revoked).toHaveBeenCalledWith('blob:pixel')
    } finally {
      created.mockRestore()
      revoked.mockRestore()
      await b.runtime.dispose()
    }
  })

  it('preserves document/image order and retains both drafts when Host admission rejects', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pixel')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      b.prompt.mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'attachment-error',
          message: 'document rejected',
          details: { reason: 'DOCUMENT_TOO_LARGE' },
        },
      })
      const [document] = b.root.createDraftDocuments([
        new File([Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d)], 'report.pdf', { type: 'application/pdf' }),
      ])
      const [image] = b.root.createDraftImages([
        new File([Uint8Array.of(1)], 'pixel.png', { type: 'image/png' }),
      ])
      if (image === undefined || document === undefined) throw new Error('draft attachment missing')

      await expect(b.root.sendSession(
        b.session,
        'retry me',
        [document.id, image.id],
        'steer',
      )).resolves.toEqual({ kind: 'error' })

      expect(b.prompt).toHaveBeenCalledWith([
        { type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=', name: 'report.pdf' },
        { type: 'image', mediaType: 'image/png', data: 'AQ==', name: 'pixel.png' },
        { type: 'text', text: 'retry me' },
      ], 'steer', undefined)
      expect(b.root.draftDocuments([document.id])).toHaveLength(1)
      expect(b.root.draftImages([image.id])).toHaveLength(1)
      expect(revoked).not.toHaveBeenCalled()
    } finally {
      created.mockRestore()
      revoked.mockRestore()
      await b.runtime.dispose()
    }
  })

  it('keeps generic documents off the slash-command image envelope', async () => {
    const b = await bench()
    try {
      const [document] = b.root.createDraftDocuments([
        new File([Uint8Array.of(1)], 'report.pdf', { type: 'application/pdf' }),
      ])
      if (document === undefined) throw new Error('draft document missing')
      await expect(b.root.serializeDraftImages([document.id]))
        .rejects.toThrow('slash commands do not accept document attachments')
      expect(b.root.draftDocuments([document.id])).toHaveLength(1)
    } finally {
      await b.runtime.dispose()
    }
  })

  it('rejects unsupported document MIME types and empty filenames before registration', async () => {
    const b = await bench()
    try {
      expect(() => b.root.createDraftDocuments([
        new File([Uint8Array.of(1)], 'notes.txt', { type: 'text/plain' }),
      ])).toThrow(UnsupportedDocumentMediaTypeError)
      expect(() => b.root.createDraftDocuments([
        new File([Uint8Array.of(1)], '', { type: 'application/pdf' }),
      ])).toThrow(InvalidDocumentNameError)
    } finally {
      await b.runtime.dispose()
    }
  })
})
