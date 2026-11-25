/**
 * The DataOps review, notification, permission and settings API.
 *
 * One transport for the four new surfaces keeps the JWT handling, 401 observation and error
 * mapping identical; the browser routes only translate same-origin actions into these calls.
 */

import type { Context } from '@deepseek-ai/cordis'
import { noteAccepted, noteExpired } from './auth-state.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'

/** Configuration shared with the skill plaza: where DataOps is and which credential holds its JWT. */
export interface ReviewApiConfig {
  baseUrl: string
  credentialRef: string
}

/** One upstream answer, status included so a 404/503 can reach the browser unchanged. */
export interface ReviewApiResult {
  status: number
  body: unknown
}

/** Cookie-free same-origin bridge to the review endpoints. */
export class ReviewApi {
  constructor(private readonly ctx: Context, private readonly config: ReviewApiConfig) {}

  private apiBase(): string {
    return new URL(this.config.baseUrl).origin
  }

  private async token(): Promise<string | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.config.credentialRef))
    return resolved?.value
  }

  /**
   * Call one DataOps endpoint with the workspace JWT.
   * @param path - API path below the DataOps origin.
   * @param init - Method, body and extra headers.
   * @returns The upstream status and parsed body; 503 when this workspace has no session.
   */
  async request(path: string, init: RequestInit = {}): Promise<ReviewApiResult> {
    const token = await this.token()
    if (token === undefined) return { status: 503, body: { error: 'DataOps is not connected' } }
    const isMultipart = typeof FormData !== 'undefined' && init.body instanceof FormData
    const response = await fetch(new URL(path, this.apiBase()), {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined || isMultipart ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
    })
    if (response.status === 401) {
      noteExpired()
      return { status: 401, body: { error: 'DataOps session expired' } }
    }
    noteAccepted()
    const text = await response.text()
    let body: unknown = null
    if (text !== '') {
      try { body = JSON.parse(text) as unknown } catch { body = { error: text } }
    }
    return { status: response.status, body }
  }
}
