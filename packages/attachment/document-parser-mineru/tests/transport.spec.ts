import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { DocumentParseRequest } from '@deepseek-ai/dsh-document-parser'
import { MinerUDocumentParserProvider } from '../src/provider.ts'

const request: DocumentParseRequest = {
  attachment: {
    attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
    mediaType: 'application/pdf',
    bytes: 5,
    name: 'sample.pdf',
  },
  data: new TextEncoder().encode('%PDF-'),
}

function provider(options: { timeoutMs?: number; maxResponseBytes?: number } = {}): MinerUDocumentParserProvider {
  return new MinerUDocumentParserProvider({
    endpoint: 'http://127.0.0.1:8000/file_parse',
    timeoutMs: options.timeoutMs ?? 5000,
    maxResponseBytes: options.maxResponseBytes ?? 1024,
  })
}

/** A fetch stand-in that settles only when the request signal aborts. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('request aborted')
}

function rejectOnAbort(): ReturnType<typeof vi.fn> {
  return vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (signal === null || signal === undefined) throw new Error('expected fetch signal')
    if (signal.aborted) {
      reject(abortReason(signal))
      return
    }
    signal.addEventListener('abort', () => { reject(abortReason(signal)) }, { once: true })
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MinerU parser transport failures', () => {
  it('maps caller cancellation to DOCUMENT_PARSE_ABORTED', async () => {
    vi.stubGlobal('fetch', rejectOnAbort())
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))

    await expect(provider().parse(request, controller.signal)).rejects.toMatchObject({
      code: 'DOCUMENT_PARSE_ABORTED',
    })
  })

  it('maps the deployment timeout to DOCUMENT_PARSE_TIMEOUT', async () => {
    vi.stubGlobal('fetch', rejectOnAbort())

    await expect(provider({ timeoutMs: 1 }).parse(request)).rejects.toMatchObject({
      code: 'DOCUMENT_PARSE_TIMEOUT',
    })
  })

  it('rejects an oversized declared response before reading its body', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(Uint8Array.of(1), {
      status: 200,
      headers: { 'content-length': '11' },
    })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(provider({ maxResponseBytes: 10 }).parse(request)).rejects.toMatchObject({
      code: 'DOCUMENT_PARSE_RESPONSE_TOO_LARGE',
    })
  })

  it('rejects an oversized streamed body when Content-Length is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(new Uint8Array(11), { status: 200 }))))

    await expect(provider({ maxResponseBytes: 10 }).parse(request)).rejects.toMatchObject({
      code: 'DOCUMENT_PARSE_RESPONSE_TOO_LARGE',
    })
  })

  it('maps non-2xx MinerU responses to DOCUMENT_PARSE_FAILED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('unavailable', { status: 503 }))))

    await expect(provider().parse(request)).rejects.toMatchObject({
      code: 'DOCUMENT_PARSE_FAILED',
      message: 'Document parser returned HTTP 503.',
    })
  })
})
