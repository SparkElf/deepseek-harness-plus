import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { relayToLocalWeb, type RelayFrame, type RelayRequest } from './index.ts'

describe('relayToLocalWeb', () => {
  const request: RelayRequest = { id: 'r1', method: 'GET', path: '/api/x', headers: {}, body: '' }
  const noop = () => {}

  it('forwards status and base64 body', async () => {
    const fake = (async () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } })) as typeof fetch
    const response = await relayToLocalWeb(request, 3080, noop, fake)
    expect(response.status).toBe(200)
    expect(response.compression).toBe('gzip')
    expect(gunzipSync(Buffer.from(response.body ?? '', 'base64')).toString('utf8')).toBe('hello')
  })

  it('round-trips binary payloads as base64', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    const fake = (async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch
    const response = await relayToLocalWeb({ ...request, body: png.toString('base64'), bodyEncoding: 'base64' }, 3080, noop, fake)
    expect(response.bodyEncoding).toBe('base64')
    expect(Buffer.from(response.body ?? '', 'base64')).toEqual(png)
  })

  it('streams event-stream responses as head/chunk/end frames', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: one\n\n'))
        controller.enqueue(new TextEncoder().encode('data: two\n\n'))
        controller.close()
      },
    })
    const fake = (async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
    const frames: RelayFrame[] = []
    await relayToLocalWeb(request, 3080, frame => frames.push(frame), fake)
    expect(frames[0]).toMatchObject({ id: 'r1', stream: true })
    const chunks = frames.filter(f => f.chunk !== undefined).map(f => Buffer.from(f.chunk ?? '', 'base64').toString('utf8'))
    expect(chunks.join('')).toBe('data: one\n\ndata: two\n\n')
    expect(frames.at(-1)).toMatchObject({ id: 'r1', end: true })
  })

  it('answers 502 when the local web is unreachable', async () => {
    const failing = (async () => { throw new Error('econnrefused') }) as typeof fetch
    const response = await relayToLocalWeb(request, 3080, noop, failing)
    expect(response.status).toBe(502)
    expect(Buffer.from(response.body ?? '', 'base64').toString('utf8')).toContain('econnrefused')
  })
})
