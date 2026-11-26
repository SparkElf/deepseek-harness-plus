/**
 * Small HTTP helpers shared by the plugin's routes.
 *
 * @module http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Client-caused HTTP body failure with the status the route should return. */
export class HttpRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'HttpRequestError'
  }
}

/** Read a JSON object body with a hard byte ceiling. */
export const readJsonBody = async (request: IncomingMessage, limit: number): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > limit) throw new HttpRequestError('请求体超过上限', 413)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  let parsed: unknown = {}
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      throw new HttpRequestError('请求体不是合法 JSON')
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpRequestError('请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

/** Write one no-store JSON response. */
export const writeJson = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}