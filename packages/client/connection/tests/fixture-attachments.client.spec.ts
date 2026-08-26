import { describe, expect, it } from 'vitest'
import type { SessionId } from '../src/client/api.ts'
import { RpcId } from '../src/client/api.ts'
import type { RpcRequest } from '../src/client/api.ts'
import { createFixtureApi } from '../src/client/fixture.ts'

const sid = (id: string): SessionId => id as SessionId
let reqCount = 0
const req = <P>(payload: P): RpcRequest<P> => ({
  rpcId: RpcId(`attachment-${String(reqCount++)}`),
  payload,
})

describe('fixture document attachments', () => {
  it('persists document prompt parts as durable document blocks without exposing them through the image attachment endpoint', async () => {
    const api = createFixtureApi()
    const sessionId = sid('fx-alpha')

    try {
      const prompt = await api.sessions.prompt(req({
        sessionId,
        mode: 'queue' as const,
        content: [{
          type: 'document' as const,
          mediaType: 'application/pdf' as const,
          data: 'JVBERg==',
          name: 'notes.pdf',
        }],
      }))
      expect(prompt.result).toEqual({ ok: true, value: { accepted: true } })

      const history = await api.sessions.history(req({ sessionId, maxMessages: 5 }))
      if (!history.result.ok) throw new Error('history failed')
      const userEvent = history.result.value.events
        .map(entry => entry.event)
        .findLast(event => event.type === 'user/message')
      if (userEvent?.type !== 'user/message') throw new Error('durable user message missing')

      const document = userEvent.data.content.find(block => block.type === 'document')
      if (document?.type !== 'document') throw new Error('durable document block missing')
      expect(document.attachment).toMatchObject({
        mediaType: 'application/pdf',
        bytes: 4,
        name: 'notes.pdf',
      })
      expect(String(document.attachment.attachmentId)).toMatch(/^fixture:/u)
      expect(document.parsed).toMatchObject({
        parser: 'fixture',
        markdown: { mediaType: 'text/markdown', name: 'notes.pdf.md' },
        contentList: { mediaType: 'application/json', name: 'notes.pdf_content_list.json' },
        images: [],
      })

      const imageRead = await api.sessions.attachment(req({
        sessionId,
        attachmentId: document.attachment.attachmentId,
      }))
      expect(imageRead.result).toMatchObject({
        ok: false,
        error: {
          code: 'attachment-error',
          details: { reason: 'ATTACHMENT_NOT_FOUND' },
        },
      })
    } finally {
      await api.sessions.cancel(req({ sessionId }))
    }
  })
})
