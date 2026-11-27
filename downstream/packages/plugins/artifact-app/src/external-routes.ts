/**
 * Host routes for the external cockpit M2 login flow.
 *
 * Every route takes a registry id; none accepts a URL. The credential list is
 * metadata only, the login executes inside the Host broker, and the screenshot
 * route returns bytes (never storage state). Secrets stay in this process.
 *
 * @module external-routes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { DataOpsError, type ArtifactApi } from './api.ts'
import type { Config } from './config.ts'
import {
  ExternalCockpitSecurityError,
  assertExternalCockpitId,
  externalRecipeFor,
  type ExternalCredentialOption,
  type ExternalCredentialQuery,
  type ExternalCredentialService,
  type ExternalCockpitRow,
} from './external.ts'
import { ExternalLoginBroker, ExternalLoginError } from './external-broker.ts'
import { HttpRequestError, readJsonBody, writeJson } from './http.ts'
import { EXTERNAL_COCKPITS_PATH } from './open-hub.ts'

/** Everything the external routes need. */
export interface ExternalRouteDeps {
  ctx: Context
  api: ArtifactApi
  config: Config
  broker: ExternalLoginBroker
}

const LOGIN_BODY_LIMIT = 16 * 1024
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u

/** Preserve a DataOps client error; report upstream/network failures as 502. */
const proxyStatus = (error: unknown): number =>
  error instanceof DataOpsError && error.status >= 400 && error.status < 500 ? error.status : 502

/** Status for one actionable login failure. */
const loginStatus = (code: ExternalLoginError['code']): number => {
  switch (code) {
    case 'RECIPE_MISSING':
    case 'CREDENTIAL_UNAVAILABLE':
    case 'SECRET_MISSING':
    case 'MFA_REQUIRED':
    case 'CAPTCHA_REQUIRED':
    case 'HEADED_DISABLED':
      return 409
    case 'BROWSER_UNAVAILABLE':
      return 503
    case 'NAVIGATION_BLOCKED':
    case 'RECIPE_INVALID':
      return 400
    case 'TIMEOUT':
    case 'LOGIN_FAILED':
      return 502
  }
}

/** Read the browser-session id from a header or, for `<img>`, the query string. */
const clientIdOf = (request: IncomingMessage, url: URL): string => {
  const header = request.headers['x-dsh-cockpit-client']
  const raw = typeof header === 'string' ? header : url.searchParams.get('client') ?? ''
  return CLIENT_ID_PATTERN.test(raw) ? raw : ''
}

/** Resolve the Host-only credential service, or undefined when the plugin is absent. */
const credentialServiceOf = (ctx: Context): ExternalCredentialService | undefined =>
  ctx.get('credentialManager') as ExternalCredentialService | undefined

/** One origin-qualified credential query for a cockpit, or null without a URL. */
const credentialQueryOf = (cockpit: ExternalCockpitRow): ExternalCredentialQuery | null => {
  if (cockpit.url === null || (cockpit.credentialType !== 'http' && cockpit.credentialType !== 'custom')) return null
  return { type: cockpit.credentialType, origin: new URL(cockpit.url).origin }
}

/** Validate a credential id before touching the credential service. */
const credentialIdOf = (value: unknown): string | null => {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !CREDENTIAL_ID_PATTERN.test(value.trim())) throw new Error('credentialId 非法')
  return value.trim()
}

/** Write the PNG screenshot for one live session. */
const writeScreenshot = (response: ServerResponse, bytes: Buffer): void => {
  response.writeHead(200, {
    'content-type': 'image/png',
    'content-length': String(bytes.byteLength),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'",
    'x-content-type-options': 'nosniff',
  })
  response.end(bytes)
}

/** Handle one `/external-cockpits/...` request; returns after writing a response. */
const handle = async (deps: ExternalRouteDeps, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const url = new URL(request.url ?? '/', 'http://dsh.internal')
  const rest = url.pathname.slice(EXTERNAL_COCKPITS_PATH.length).replace(/^\/+/u, '')
  const parts = rest === '' ? [] : rest.split('/')
  if (parts.length === 0 || parts.some((part) => part === '')) {
    writeJson(response, 404, { error: '缺少外部驾驶舱 id' })
    return
  }
  let id: string
  try {
    id = assertExternalCockpitId(decodeURIComponent(parts[0] ?? ''))
  } catch (error) {
    writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    return
  }
  const method = request.method ?? 'GET'

  try {
    if (parts.length === 1) {
      if (method !== 'GET') { writeJson(response, 405, { error: 'GET only' }); return }
      writeJson(response, 200, await deps.api.getExternalCockpit(id))
      return
    }

    if (parts.length === 2 && parts[1] === 'link') {
      if (method !== 'POST') { writeJson(response, 405, { error: 'POST only' }); return }
      writeJson(response, 200, await deps.api.linkExternalCockpit(id))
      return
    }

    if (parts.length === 2 && parts[1] === 'credentials') {
      if (method !== 'GET') { writeJson(response, 405, { error: 'GET only' }); return }
      const detail = await deps.api.getExternalCockpitHostDetail(id)
      const cockpit = detail.cockpit
      const query = credentialQueryOf(cockpit)
      const service = credentialServiceOf(deps.ctx)
      const credentials: ExternalCredentialOption[] = query !== null && service !== undefined
        ? await service.listForSite(query)
        : []
      let recipeAvailable = false
      let recipeError: string | null = null
      try {
        recipeAvailable = externalRecipeFor(detail, deps.config.externalLoginRecipes) !== null
      } catch (error) {
        recipeError = error instanceof Error ? error.message : String(error)
      }
      writeJson(response, 200, {
        cockpitId: cockpit.id,
        name: cockpit.name,
        credentialType: cockpit.credentialType,
        siteOrigin: cockpit.url === null ? null : new URL(cockpit.url).origin,
        credentialServiceAvailable: service !== undefined,
        credentials,
        recipeAvailable,
        recipeError,
        headedEnabled: deps.config.externalHeadedEnabled,
      })
      return
    }

    if (parts.length === 2 && parts[1] === 'login') {
      if (method !== 'POST') { writeJson(response, 405, { error: 'POST only' }); return }
      const body = await readJsonBody(request, LOGIN_BODY_LIMIT)
      const clientId = typeof body.clientId === 'string' && CLIENT_ID_PATTERN.test(body.clientId)
        ? body.clientId
        : clientIdOf(request, url)
      if (clientId === '') throw new ExternalLoginError('LOGIN_FAILED', '缺少浏览器会话标识')
      const mode = body.mode === undefined ? 'headless' : body.mode
      if (mode !== 'headless' && mode !== 'headed') throw new Error('mode 只能是 headless 或 headed')

      const detail = await deps.api.getExternalCockpitHostDetail(id)
      const cockpit = detail.cockpit
      if (cockpit.url === null) throw new ExternalLoginError('NAVIGATION_BLOCKED', '该驾驶舱没有合法的 HTTPS 地址')
      const query = credentialQueryOf(cockpit)
      let credential: {
        id: string | null
        name: string | null
        username: string | null
        secret: Record<string, string>
      } = { id: null, name: null, username: null, secret: {} }
      if (query !== null) {
        const credentialId = credentialIdOf(body.credentialId)
        if (credentialId === null) {
          throw new ExternalLoginError(
            'CREDENTIAL_UNAVAILABLE',
            '该驾驶舱需要凭据，请先选择一条匹配的凭据',
            false,
            '凭据必须与驾驶舱的 credential_type 和 origin 匹配。',
          )
        }
        const service = credentialServiceOf(deps.ctx)
        if (service === undefined) {
          throw new ExternalLoginError(
            'CREDENTIAL_UNAVAILABLE',
            '未安装 credential-manager，无法解析凭据',
            false,
            '安装并启用 credential-manager 后重试。',
          )
        }
        const option = await service.describeForSite(credentialId, query)
        credential = {
          id: option.id,
          name: option.name,
          username: option.username,
          secret: (await service.readSecret(option.id)) ?? {},
        }
      }

      let recipe: ReturnType<typeof externalRecipeFor>
      try {
        recipe = externalRecipeFor(detail, deps.config.externalLoginRecipes)
      } catch (error) {
        throw new ExternalLoginError('RECIPE_INVALID', error instanceof Error ? error.message : '登录 recipe 非法')
      }
      if (recipe === null) {
        throw new ExternalLoginError(
          'RECIPE_MISSING',
          '该外部驾驶舱尚未配置登录 recipe',
          false,
          '由管理员在注册表或插件配置 externalLoginRecipes 中提供 recipe 后再试。',
        )
      }

      const view = await deps.broker.login({
        cockpit,
        recipe,
        allowedOrigins: detail.allowedOrigins,
        credential,
        mode,
        clientId,
      })
      let stableUrl: string | null = null
      try {
        stableUrl = (await deps.api.linkExternalCockpit(id)).url
      } catch {
        // The session and screenshot are still useful when link issuance fails.
      }
      writeJson(response, 200, { ...view, stableUrl })
      return
    }

    if (parts.length === 3 && parts[1] === 'sessions') {
      if (method !== 'DELETE') { writeJson(response, 405, { error: 'DELETE only' }); return }
      const clientId = clientIdOf(request, url)
      if (clientId === '') { writeJson(response, 400, { error: '缺少浏览器会话标识' }); return }
      deps.broker.end(id, parts[2] ?? '', clientId)
      writeJson(response, 200, { ok: true })
      return
    }

    if (parts.length === 4 && parts[1] === 'sessions' && parts[3] === 'screenshot') {
      if (method !== 'GET') { writeJson(response, 405, { error: 'GET only' }); return }
      const clientId = clientIdOf(request, url)
      if (clientId === '') { writeJson(response, 400, { error: '缺少浏览器会话标识' }); return }
      writeScreenshot(response, deps.broker.screenshot(id, parts[2] ?? '', clientId))
      return
    }

    writeJson(response, 404, { error: '未知的外部驾驶舱路由' })
  } catch (error) {
    if (error instanceof ExternalLoginError) {
      writeJson(response, loginStatus(error.code), {
        ok: false,
        code: error.code,
        message: error.message,
        hint: error.hint,
        headedAvailable: error.headedAvailable,
      })
      return
    }
    if (error instanceof ExternalCockpitSecurityError) {
      writeJson(response, 400, { ok: false, code: error.code, message: error.message, hint: '', headedAvailable: false })
      return
    }
    if (error instanceof HttpRequestError) {
      writeJson(response, error.status, { error: error.message })
      return
    }
    if (error instanceof DataOpsError) {
      writeJson(response, proxyStatus(error), { error: error.message })
      return
    }
    deps.ctx.logger.error('[dsh-artifact-app] external cockpit route failed', error)
    writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Register the prefix route that owns external cockpit detail, credentials,
 * login, session screenshot and session teardown.
 * @param deps - API client, config and the login broker.
 */
export function registerExternalCockpitRoutes(deps: ExternalRouteDeps): void {
  deps.ctx.effect(() => deps.ctx.webServer.register({
    kind: 'prefix',
    path: EXTERNAL_COCKPITS_PATH,
    handler: (request, response) => handle(deps, request, response),
  }), 'artifact-app: external cockpit detail, credentials and login routes')
}