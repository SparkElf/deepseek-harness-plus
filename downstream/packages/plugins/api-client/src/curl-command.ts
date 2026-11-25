/**
 * Build a cURL command from a SAVED request.
 *
 * Host-only: it reads the stored authorization secret, so the browser never has to
 * assemble a command around a credential it was not given. Kept out of `curl.ts` because
 * that module is also bundled into the client, and `Buffer` is not available there.
 *
 * @module @sparkelf/dsh-api-client/curl-command
 */

import type { ApiAuthSecretInput, ApiRequest } from './types.ts'
import { interpolate, shellQuote } from './curl.ts'

/**
 * Build the `curl` command for one saved request.
 *
 * The command is assembled from the SAVED request plus the environment's resolved values
 * and the stored authorization, which is why the host builds it: the browser is not given
 * the secret to assemble it itself.
 * @param request - the request that produced the response.
 * @param variables - resolved environment values.
 * @param secret - the request's stored authorization secret, when it has one.
 * @param cookieHeader - cookies the client would send for this URL.
 * @returns a multi-line command, one part per line for readability.
 */
export function buildCurlCommand(
  request: ApiRequest,
  variables: Record<string, string>,
  secret: ApiAuthSecretInput | undefined,
  cookieHeader: string,
): string {
  let url: URL
  try { url = new URL(interpolate(request.url, variables)) } catch (cause) { throw new Error('the request URL cannot be resolved: ' + (cause instanceof Error ? cause.message : String(cause))) }
  const headers = request.headers.filter(value => value.enabled).map(value => [interpolate(value.key, variables), interpolate(value.value, variables)] as const)
  const headerExists = (name: string): boolean => headers.some(([key]) => key.toLowerCase() === name)
  const extraHeaders: Array<[string, string]> = []
  if (cookieHeader !== '' && !headerExists('cookie')) extraHeaders.push(['Cookie', cookieHeader])
  const kind = request.auth.kind
  if (kind === 'basic' && secret !== undefined) {
    extraHeaders.push(['Authorization', 'Basic ' + Buffer.from((secret.username ?? '') + ':' + (secret.password ?? '')).toString('base64')])
  } else if ((kind === 'bearer' || kind === 'oauth2') && secret?.token !== undefined && !headerExists('authorization')) {
    extraHeaders.push(['Authorization', 'Bearer ' + secret.token])
  } else if (kind === 'api-key' && secret?.key !== undefined) {
    const name = request.auth.options.name?.trim() ?? ''
    if (name !== '') {
      if (request.auth.options.location === 'query') url.searchParams.set(name, secret.key)
      else if (!headerExists(name.toLowerCase())) extraHeaders.push([name, secret.key])
    }
  }
  for (const item of request.query.filter(value => value.enabled)) url.searchParams.append(interpolate(item.key, variables), interpolate(item.value, variables))
  const lines: string[] = ['curl -X ' + request.method + ' ' + shellQuote(url.toString())]
  for (const [key, value] of [...headers, ...extraHeaders]) lines.push('  -H ' + shellQuote(key + ': ' + value))
  if (request.body.kind !== 'none') {
    let body = interpolate(request.body.content, variables)
    if (request.body.kind === 'json' && !headerExists('content-type')) lines.push("  -H 'content-type: application/json'")
    if (request.body.kind === 'form' && !headerExists('content-type')) lines.push("  -H 'content-type: application/x-www-form-urlencoded'")
    if (request.body.kind === 'graphql') body = JSON.stringify({ query: body })
    lines.push('  --data-raw ' + shellQuote(body))
  }
  return lines.join(' \\\n')
}
