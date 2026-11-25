import type { ApiMultipartPart, ApiRequest, ApiResponse } from '../types.ts'
import { undefinedVariables } from '../curl.ts'

export function responseForRequest(history: ApiResponse[], requestId: string | undefined, selectedResponseId: string | null): ApiResponse | null {
  if (requestId === undefined || requestId === '') return null
  const responses = history.filter(item => item.requestId === requestId)
  return responses.find(item => item.id === selectedResponseId) ?? responses[0] ?? null
}

export function readMultipartParts(content: string): ApiMultipartPart[] {
  if (content.trim() === '') return []
  try {
    const value = JSON.parse(content) as unknown
    if (!Array.isArray(value)) return []
    return value.flatMap(item => {
      if (typeof item !== 'object' || item === null) return []
      const part = item as Partial<ApiMultipartPart>
      if (typeof part.key !== 'string' || typeof part.value !== 'string') return []
      return [{ key: part.key, value: part.value, enabled: part.enabled !== false, type: part.type === 'file' ? 'file' : 'text', fileName: part.fileName, contentType: part.contentType, encoding: part.encoding }]
    })
  } catch { return [] }
}

export function writeMultipartParts(parts: ApiMultipartPart[]): string {
  return JSON.stringify(parts, null, 2)
}

export function cloneRequest(request: ApiRequest): ApiRequest {
  return {
    ...request,
    query: request.query.map(item => ({ ...item })),
    headers: request.headers.map(item => ({ ...item })),
    auth: { ...request.auth, options: { ...request.auth.options } },
    body: { ...request.body },
  }
}

export function requestFingerprint(request: ApiRequest): string {
  return JSON.stringify(request)
}

export function formatResponseBody(body: string): string {
  const trimmed = body.trim()
  if (trimmed === '') return ''
  try { return JSON.stringify(JSON.parse(trimmed), null, 2) } catch { return body }
}

export function responseCookies(response: ApiResponse): { name: string; value: string; attributes: string }[] {
  return response.headers
    .filter(header => header.enabled && header.key.toLowerCase() === 'set-cookie')
    .flatMap(header => header.value.split(/,(?=[^;,]+=)/))
    .map(value => {
      const [pair = '', ...attributes] = value.split(';')
      const separator = pair.indexOf('=')
      return {
        name: separator < 0 ? pair.trim() : pair.slice(0, separator).trim(),
        value: separator < 0 ? '' : pair.slice(separator + 1).trim(),
        attributes: attributes.map(item => item.trim()).join('; '),
      }
    })
    .filter(cookie => cookie.name !== '')
}


/**
 * Validate a JSON request body without throwing at send time.
 *
 * The editor shows the verdict while the reader types; the executor still parses the body
 * before sending, because a validation hint is not an enforcement point.
 * @param content - the body text.
 * @returns validity plus the parser's message when invalid.
 */
export function validateJsonBody(content: string): { valid: boolean; message?: string } {
  if (content.trim() === '') return { valid: true }
  try { JSON.parse(content); return { valid: true } } catch (error) {
    return { valid: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * One JSON node's path in the notation a reader can paste into code.
 * @param path - object keys and array indices from the root.
 * @returns `$`, `$.a`, `$[0]`, `$.a[2].b` style text.
 */
export function jsonPathLabel(path: readonly (string | number)[]): string {
  let label = '$'
  for (const segment of path) {
    if (typeof segment === 'number') label += '[' + String(segment) + ']'
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(segment)) label += '.' + segment
    else label += '[' + JSON.stringify(segment) + ']'
  }
  return label
}

/**
 * Every `{{name}}` a request refers to that the active environment does not define.
 *
 * Covers the URL, enabled params and headers, and the body: those are the four places the
 * executor interpolates, so a name missing from this list is one the send will refuse.
 * @param request - the draft being edited.
 * @param variables - the active environment's keys (values are irrelevant here).
 * @returns unique names, in first-appearance order.
 */
export function findUndefinedVariables(request: ApiRequest, variables: Record<string, string>): string[] {
  const texts = [
    request.url,
    ...request.query.filter(item => item.enabled).flatMap(item => [item.key, item.value]),
    ...request.headers.filter(item => item.enabled).flatMap(item => [item.key, item.value]),
    request.body.content,
    ...Object.values(request.auth.options),
  ]
  const missing: string[] = []
  for (const text of texts) for (const name of undefinedVariables(text, variables)) if (!missing.includes(name)) missing.push(name)
  return missing
}
