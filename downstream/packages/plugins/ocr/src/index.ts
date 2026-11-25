/**
 * Host half of the document-text-recognition plugin.
 *
 * Two contributions, and they serve different audiences:
 *
 * 1. **The skill provider.** The package ships one file the model needs -- `SKILL.md` -- and
 *    it does not live under a directory the skill registry scans, because `node_modules` is
 *    not a scan root. Registering it explicitly is the same thing
 *    `@sparkelf/dsh-dataops-admin` and `@sparkelf/dsh-knowledge-base` do.
 *
 * 2. **The settings route.** The settings page cannot call the DataOps backend directly: the
 *    browser's credential is an httpOnly cookie and the backend's `/api/ocr/*` routes want a
 *    bearer. This Host holds the DataOps JWT (or adopts the one the gateway attached), so it
 *    relays the four OCR calls and the page talks only to this process.
 *
 * The MinerU address is NOT stored here. Every member gets their own workspace container and
 * their own DSH profile, so a per-profile setting cannot reach anybody else; the shared value
 * lives in the backend (`GET /api/ocr/config`), which this half reads and relays. A copy in
 * this profile would be a second source of truth that silently goes stale.
 *
 * @module @sparkelf/dsh-ocr
 */

import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { OCR_API, OCR_API_PREFIX, type OcrApiMethod, type OcrProbeCode, type OcrProbeView } from './api.ts'

/** The name this plugin mounts as in the profile composition. */
export const PLUGIN_NAME = '@sparkelf/dsh-ocr'

/**
 * Host services this plugin needs before `apply` runs.
 *
 * Declared rather than reached for: Cordis resolves a service through the plugin's own
 * context, and touching one that was not injected throws
 * `cannot get property "webServer" without inject` during apply -- which took the whole
 * plugin down and, with it, the skill registration. `webServer` carries the settings relay,
 * `credentials` resolves the fallback DataOps token.
 *
 * `skills` is deliberately absent: the registry is an OPTIONAL neighbour, so it is reached
 * through `ctx.inject` inside apply and skipped on a host that does not have it.
 */
export const inject = ['webServer', 'credentials']

/** Provider name reported to the skill registry. */
export const SKILL_PROVIDER = 'dsh-ocr'

/**
 * Name the model sees in the skill catalog.
 *
 * Must match `^[a-z0-9]+(?:-[a-z0-9]+)*$`: the skill center silently skips a directory that
 * does not, and this value keys the provider.
 */
export const SKILL_NAME = 'ocr'

/**
 * Short description shown in the skill list.
 *
 * Kept beside the SKILL.md body rather than parsed out of its frontmatter: the catalog
 * answers `list()` without reading any skill content, so the text has to be available
 * without touching the file.
 */
export const SKILL_DESCRIPTION =
  '识别 PDF、图片、扫描件等文档中的文字并输出 Markdown，使用管理员统一配置的 MinerU 服务。'

/**
 * Display name the skill center shows for this skill.
 *
 * Deliberately NOT the registry name: `ocr` is the internal identifier, while users must see
 * a business-facing Chinese name. The skill center reads the display name from the
 * `i18n/zh.json` beside SKILL.md; this constant is the same string, so a host that reports
 * the catalog without the translation file still has the right name.
 */
export const SKILL_DISPLAY_NAME = '文档文字识别'

/**
 * Where this package's SKILL.md lives, from either build layout.
 *
 * The build emits `lib/index.js` while a source run executes from `src/`; both sit one level
 * below the package root, so the same `..` answers both.
 *
 * @returns absolute path of the skill document.
 */
export function skillPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md')
}

/** Both a human and the model may invoke this skill. */
export const SKILL_INVOCATION = { modelInvocable: true, userInvocable: true } as const

/**
 * Rank places this beside the other bundled DataOps capabilities.
 *
 * `knowledge-base` uses 640 and `dataops-admin` uses 641; this one follows them. The value
 * orders a catalog listing, not a priority -- the model reaches for these by name.
 */
export const SKILL_RANK = 642

/**
 * The methods this Host relays to the DataOps backend.
 *
 * `test-connection` is answered by this process itself (it probes MinerU from inside the
 * workspace network), so it is excluded from the backend route map rather than mapped to
 * a path that does not exist.
 */
export type OcrBackendMethod = Exclude<OcrApiMethod, typeof OCR_API.testConnection>

/** Backend path each relayed method calls, and the HTTP method it uses. */
export const OCR_BACKEND_ROUTES: Readonly<Record<OcrBackendMethod, { path: string; method: 'GET' | 'POST' }>> = {
  config: { path: '/api/ocr/config', method: 'GET' },
  impact: { path: '/api/ocr/admin/impact', method: 'GET' },
  'distribute-default': { path: '/api/ocr/admin/distribute-default', method: 'POST' },
  overwrite: { path: '/api/ocr/admin/overwrite', method: 'POST' },
}

/**
 * One catalog entry, shaped like the host's `SkillCandidate`.
 *
 * Declared here instead of imported: this plugin does not depend on the skill package (the
 * registry is an optional injection), so the structural contract is restated rather than
 * turning an optional neighbour into a build requirement. The registry merges these by the
 * fields it reads, so a shape that satisfies them is the contract.
 */
export interface SkillCandidateLike {
  readonly name: string
  readonly description: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly source: 'bundled'
  readonly provider: string
  readonly path: string
  readonly resourceBase: { readonly kind: 'directory'; readonly path: string }
  readonly rank: number
  readonly locator: string
}

/** One loaded skill, shaped like the host's `SkillDefinition`. */
export interface SkillDefinitionLike extends SkillCandidateLike {
  readonly content: string
}

/**
 * The skill provider that teaches the model to recognise document text.
 *
 * One bundled skill, read from disk on `get()` rather than kept in memory: the body is
 * documentation, and a host that never asks for it should not pay for it.
 *
 * @returns a provider the skill registry can register.
 */
export function ocrSkillProvider(): {
  readonly name: string
  readonly list: (options: { readonly cwd?: string; readonly signal?: AbortSignal }) => Promise<readonly SkillCandidateLike[]>
  readonly get: (candidate: SkillCandidateLike, options: { readonly cwd?: string; readonly signal?: AbortSignal }) => Promise<SkillDefinitionLike | undefined>
} {
  const path = skillPath()
  const candidate: SkillCandidateLike = {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    invocation: SKILL_INVOCATION,
    source: 'bundled',
    provider: SKILL_PROVIDER,
    path,
    resourceBase: { kind: 'directory', path: dirname(path) },
    rank: SKILL_RANK,
    locator: path,
  }
  return {
    name: SKILL_PROVIDER,
    list: () => Promise.resolve([candidate]),
    get: () => Promise.resolve({ ...candidate, content: readFileSync(path, 'utf8') }),
  }
}

/**
 * Read the bearer the browser gateway attached to one request.
 *
 * The page cannot supply its own credential: every browser request reaches this workspace
 * through the DataOps gateway, which resolves the caller's session and forwards a fresh
 * `authorization: Bearer <jwt>`. Relaying exactly that header is what keeps the backend's
 * `AuthGuard` and `PermissionGuard` judging the CALLER rather than this plugin: the admin
 * routes answer 403 for a member who is not a super administrator because the token in the
 * header is theirs, not a service account's.
 *
 * @param request - the incoming request, whose headers the gateway filled in.
 * @returns the token, or undefined when the request carries none.
 */
export function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization?.trim() ?? ''
  if (!authorization.startsWith('Bearer ')) return undefined
  const token = authorization.slice(7).trim()
  return token === '' ? undefined : token
}

/** Deployment configuration for the settings relay. */
export interface OcrConfig {
  /**
   * DataOps backend origin.
   *
   * The settings page cannot reach the backend itself -- its credential is an httpOnly cookie
   * while `/api/ocr/*` wants a bearer -- so this Host relays the four calls. The origin is a
   * profile value rather than a constant because a self-hosted backend and a managed one are
   * different addresses.
   */
  baseUrl: string
  /**
   * Credential holding the DataOps JWT.
   *
   * Only a fallback: the request's own `authorization` header wins, because the backend must
   * judge the CALLER. A service credential would make every member an administrator.
   */
  credentialRef: string
  /** Bound on one backend call. */
  timeoutMs: number
}

/** Config schema; an invalid value fails the profile load loudly. */
export const Config: z<OcrConfig> = z.object({
  baseUrl: z.string().default(''),
  credentialRef: z.string().role('credential-ref').default('DATAOPS_ACCESS_TOKEN'),
  timeoutMs: z.number().default(15_000),
})

/** Everything the relay needs, resolved once at apply time. */
export interface OcrRelayConfig {
  /** DataOps backend origin, e.g. `http://host.docker.internal:8080`. */
  readonly baseUrl: string
  /** Credential name to fall back on when the request carries no bearer. */
  readonly credentialRef: string
  /** Bound on one backend call. */
  readonly timeoutMs: number
}

/**
 * Resolve the token one relayed call acts with.
 *
 * The caller's own header wins: it is the only value that makes the backend's permission
 * checks correct. The stored credential is the fallback for a same-origin fetch that arrived
 * without a header (a probe, or an older page); a plugin instance without either refuses
 * rather than calling the backend anonymously, because an anonymous call would be answered
 * 401 by the backend anyway and the page could not tell why.
 *
 * @param ctx - host context carrying the credential store.
 * @param config - relay configuration.
 * @param request - the incoming request.
 * @returns the token, or undefined when neither source has one.
 */
export async function resolveRelayToken(
  ctx: { credentials: { resolve: (ref: unknown) => Promise<{ value: string } | undefined> } },
  config: OcrRelayConfig,
  request: IncomingMessage,
): Promise<string | undefined> {
  const fromRequest = bearerToken(request)
  if (fromRequest !== undefined) return fromRequest
  const stored = await ctx.credentials.resolve(credentialRef(config.credentialRef)).catch(() => undefined)
  const value = stored?.value.trim() ?? ''
  return value === '' ? undefined : value
}

/** One relayed call's result: the backend's status and decoded body. */
export interface RelayResult {
  readonly status: number
  readonly body: unknown
}

/**
 * Call one DataOps OCR route with the caller's authority.
 *
 * Kept separate from the route handler so the mapping from a page method to a backend path
 * is testable without a server.
 *
 * @param method - which of the four relayed routes the page asked for.
 * @param config - backend origin, credential fallback, and the call bound.
 * @param token - the bearer to act with; a call without one is refused before the round trip.
 * @param body - the JSON body, for the two write routes.
 * @returns the backend's status and decoded body.
 */
export async function callOcrBackend(
  method: OcrBackendMethod,
  config: OcrRelayConfig,
  token: string | undefined,
  body?: Record<string, unknown>,
): Promise<RelayResult> {
  if (token === undefined) return { status: 401, body: { error: 'the request carries no DataOps session token' } }
  if (config.baseUrl.trim() === '') {
    return { status: 503, body: { error: 'the DataOps backend address is not configured' } }
  }
  const route = OCR_BACKEND_ROUTES[method]
  const url = `${config.baseUrl.trim().replace(/\/+$/u, '')}${route.path}`
  let response: Response
  try {
    response = await fetch(url, {
      method: route.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(route.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(route.method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (cause) {
    return {
      status: 502,
      body: { error: `the DataOps backend is unreachable at ${url}`, detail: String(cause) },
    }
  }
  const decoded = await response.json().catch(() => ({}))
  return { status: response.status, body: decoded }
}

/** Longest a single connection test may block the settings panel. */
export const PROBE_TIMEOUT_MS = 8_000

/**
 * Probe one MinerU address from this process.
 *
 * The OpenAPI document is the cheapest endpoint that both proves an HTTP server answers
 * and identifies it: MinerU titles its document "MinerU API", so a 200 with that title is
 * a real match rather than "something is listening on this port". Any other 200 is
 * reported as `not-mineru` -- a proxy error page or a different service are both reasons
 * the reader should not save the address.
 *
 * The probe deliberately does not use the caller's DataOps credential: MinerU is not a
 * DataOps service and has its own (usually absent) auth. It also refuses non-http(s)
 * schemes so the relay cannot be used to read `file:` or `ftp:` URLs.
 * @param address - the candidate base address, as typed or as stored.
 * @param timeoutMs - the caller's relay bound; the probe is clamped to {@link PROBE_TIMEOUT_MS}.
 * @returns a structured verdict for the settings page.
 */
export async function probeMineruAddress(address: string, timeoutMs: number): Promise<OcrProbeView> {
  const trimmed = address.trim()
  let base: URL
  try {
    base = new URL(trimmed)
  } catch {
    return { ok: false, latencyMs: 0, code: 'bad-url', testedUrl: trimmed }
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    return { ok: false, latencyMs: 0, code: 'bad-url', testedUrl: trimmed }
  }
  const endpoint = base.toString().replace(/\/+$/u, '') + '/openapi.json'
  const started = Date.now()
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.min(timeoutMs, PROBE_TIMEOUT_MS)),
    })
    const latencyMs = Date.now() - started
    if (response.status !== 200) {
      return { ok: false, latencyMs, code: 'http-error', status: response.status, testedUrl: trimmed }
    }
    const document = await response.json().catch(() => undefined) as
      { info?: { title?: unknown } } | undefined
    const title = typeof document?.info?.title === 'string' ? document.info.title : ''
    if (/mineru/iu.test(title)) {
      return { ok: true, latencyMs, code: 'ok', status: 200, message: title, testedUrl: trimmed }
    }
    return {
      ok: false,
      latencyMs,
      code: 'not-mineru',
      status: 200,
      message: title === '' ? 'the OpenAPI document has no service title' : title,
      testedUrl: trimmed,
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const code: OcrProbeCode = /timeout|timed out|aborted/iu.test(message) ? 'timeout' : 'unreachable'
    return { ok: false, latencyMs: Date.now() - started, code, message: message.slice(0, 300), testedUrl: trimmed }
  }
}

/**
 * Write one JSON reply.
 *
 * @param response - the browser-facing response.
 * @param status - HTTP status to send.
 * @param body - value to serialize.
 */
export function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

/**
 * Read a JSON request body, treating an empty body as `{}`.
 *
 * @param request - the incoming request.
 * @returns the parsed object.
 */
export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        resolve(JSON.parse(text) as Record<string, unknown>)
      } catch (error) {
        reject(new Error('request body is not valid JSON', { cause: error }))
      }
    })
    request.on('error', reject)
  })
}

/**
 * Answer one `test-connection` request.
 *
 * The stored config is read through the backend first, for two reasons that are really
 * one: the backend is the authority on whether this caller may change the address, and a
 * caller who may not change it must not be able to make this process fetch an arbitrary
 * URL. A super administrator may test the value they are about to save; everyone else
 * tests the shared value.
 * @param ctx - the host context, for the caller's token.
 * @param config - backend origin and probe bound.
 * @param request - the browser request, whose body may carry a candidate address.
 * @param response - the reply.
 */
export async function answerConnectionTest(
  ctx: OcrHostContext,
  config: OcrRelayConfig,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const token = await resolveRelayToken(ctx, config, request)
  if (token === undefined) {
    writeJson(response, 401, { error: 'the request carries no DataOps session token' })
    return
  }
  const current = await callOcrBackend('config', config, token)
  if (current.status !== 200) {
    writeJson(response, 503, {
      error: 'the caller role could not be checked against the DataOps backend',
      detail: current.body,
    })
    return
  }
  const view = current.body as { mineruUrl?: unknown; canEdit?: unknown }
  const stored = typeof view.mineruUrl === 'string' ? view.mineruUrl : ''
  const body = await readJsonBody(request)
  const candidate = typeof body.mineruUrl === 'string' ? body.mineruUrl.trim() : ''
  const target = view.canEdit === true && candidate !== '' ? candidate : stored
  writeJson(response, 200, await probeMineruAddress(target, config.timeoutMs))
}

/** The subset of the host context this plugin uses. */
export interface OcrHostContext {
  readonly credentials: { resolve: (ref: unknown) => Promise<{ value: string } | undefined> }
  readonly webServer: {
    register: (options: {
      kind: 'prefix'
      path: string
      handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
    }) => () => void
  }
  readonly logger?: { warn: (...args: unknown[]) => void }
  readonly effect: (run: () => () => void, label?: string) => void
  readonly inject?: (
    deps: readonly string[],
    run: (scoped: { skills: { registerProvider: (provider: () => unknown) => unknown } }) => void,
  ) => void
}

/**
 * Mount the skill provider and the settings relay on a host context.
 *
 * `inject` rather than a hard dependency entry, and the `typeof` guard around it, are both
 * copied from `@sparkelf/dsh-knowledge-base`: the skill registry is an optional neighbour, and
 * calling `inject` on a host that does not expose it would throw during apply and take the
 * whole plugin down.
 *
 * @param host - the plugin context.
 * @param resolvedConfig - backend origin, credential fallback, and call bound.
 */
export function apply(host: unknown, resolvedConfig?: Partial<OcrConfig>): void {
  // The null check comes first, and is not redundant with the `typeof` test below: on an
  // `undefined`/`null` host the property read itself throws, so a guard written only around
  // `inject` would take the plugin down instead of skipping the registration.
  if (host === null || host === undefined) return
  const ctx = host as Partial<OcrHostContext>

  const hostWithInject = ctx as {
    inject?: (deps: readonly string[], run: (scoped: { skills: { registerProvider: (provider: () => unknown) => unknown } }) => void) => void
  }
  if (typeof hostWithInject.inject === 'function') {
    hostWithInject.inject(['skills'], (scoped) => {
      scoped.skills.registerProvider(() => ocrSkillProvider() as never)
    })
  }

  // The relay is what makes the settings page work at all, so a host without a webserver or
  // credential store skips it rather than throwing: the skill half is still useful on such a
  // host, and apply() must never take the plugin down.
  if (ctx.webServer === undefined || ctx.credentials === undefined || typeof ctx.effect !== 'function') return

  const config: OcrRelayConfig = {
    baseUrl: resolvedConfig?.baseUrl ?? '',
    credentialRef: resolvedConfig?.credentialRef ?? 'DATAOPS_ACCESS_TOKEN',
    timeoutMs: resolvedConfig?.timeoutMs ?? 15_000,
  }

  ctx.effect(() => ctx.webServer!.register({
    kind: 'prefix',
    path: OCR_API_PREFIX,
    handler: async (request, response) => {
      const method = new URL(request.url ?? '/', 'http://dsh.internal').pathname
        .slice(`${OCR_API_PREFIX}/`.length) as OcrApiMethod
      try {
        if (method === OCR_API.testConnection) {
          await answerConnectionTest(ctx as OcrHostContext, config, request, response)
          return
        }
        const route = OCR_BACKEND_ROUTES[method as OcrBackendMethod]
        if (route === undefined) {
          writeJson(response, 404, { error: `unknown document-recognition method: ${method}` })
          return
        }
        const token = await resolveRelayToken(ctx as OcrHostContext, config, request)
        const body = route.method === 'POST' ? await readJsonBody(request) : undefined
        const result = await callOcrBackend(method as OcrBackendMethod, config, token, body)
        writeJson(response, result.status, result.body)
      } catch (error) {
        // A relay failure is reported as a relay failure. Passing a backend refusal through
        // unchanged is what lets the page show the backend's own message rather than a
        // generic "something went wrong".
        ctx.logger?.warn?.('dsh-ocr: settings relay failed')
        ctx.logger?.warn?.(error)
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dsh-ocr: settings relay')
}
