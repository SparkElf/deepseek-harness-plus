/**
 * DataOps cockpit artifacts in the DSH right sidebar.
 *
 * The host owns the token and the HTML bytes: it exposes a render route, a narrow
 * gateway for the sandboxed page, an SSE channel for "open this cockpit", the nine
 * model tools, and the authoring skill. The client half owns the sidebar tab and
 * the file viewer; neither half decides permissions — every DataOps call does.
 *
 * @module @sparkelf/dsh-artifact-app
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import { ArtifactApi, type TokenSource } from './api.ts'
import { Config as ConfigSchema, type Config as ConfigValues } from './config.ts'
import {
  APPS_PATH,
  ARTIFACT_TAB_TYPE,
  CONFIG_PATH,
  GATEWAY_PATH,
  OPEN_EVENTS_PATH,
  OpenCockpitHub,
  PREVIEW_PATH,
  RENDER_PATH,
  TEMPLATES_PATH,
  TOKEN_PATH,
} from './open-hub.ts'
import { assertCockpitHtml, cockpitCsp, injectCockpitRuntime } from './templates.ts'
import { registerCockpitTools } from './tools.ts'

export const Config = ConfigSchema
export type Config = ConfigValues
export * from './api.ts'
export * from './open-hub.ts'
export * from './templates.ts'

/** Cordis plugin name. */
export const name = 'artifact-app'
/** Host services this plugin needs. */
export const inject = ['webServer', 'tools', 'approval', 'credentials', 'skills']

/** Skill id contributed by this package. */
const SKILL_NAME = 'artifact-app-authoring'
const SKILL_FILE = new URL('../skills/artifact-app-authoring/SKILL.md', import.meta.url)
const SKILL_ROOT = fileURLToPath(new URL('../', import.meta.url))

/** Read a request body with a hard ceiling. */
const readJsonBody = async (request: IncomingMessage, limit: number): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > limit) throw new Error('请求体超过上限')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() === '' ? {} : JSON.parse(text) as Record<string, unknown>
}

/** Write one JSON response. */
const writeJson = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

/** The browser-facing origin of this DSH instance. */
const requestOrigin = (request: IncomingMessage): string => {
  const header = (name: string): string | undefined => {
    const value = request.headers[name]
    return Array.isArray(value) ? value[0] : value
  }
  const proto = header('x-forwarded-proto')?.split(',')[0]?.trim() || 'http'
  const host = header('x-forwarded-host')?.split(',')[0]?.trim() || header('host') || '127.0.0.1:3080'
  return proto + '://' + host
}

/** Cache the principal's create capability; the backend still authorizes every call. */
class PermissionCache {
  private roles: string[] = []
  private expiresAt = 0
  private pending: Promise<string[]> | undefined

  constructor(private readonly api: ArtifactApi) {}

  private async load(): Promise<string[]> {
    const me = await this.api.me()
    return (me.user?.roles ?? []).map((role) => role.code ?? role.name ?? '').filter((role) => role !== '')
  }

  async canCreate(): Promise<boolean> {
    if (Date.now() > this.expiresAt) {
      this.pending ??= this.load().finally(() => { this.pending = undefined })
      try {
        this.roles = await this.pending
        this.expiresAt = Date.now() + 60_000
      } catch {
        this.expiresAt = Date.now() + 10_000
      }
    }
    return this.roles.some((role) => role.includes('管理员') || /admin/iu.test(role))
  }
}

/** Skill descriptor; the body is read only when the catalog loads it. */
const buildSkill = () => ({
  name: SKILL_NAME,
  description:
    '根据数据资源制作驾驶舱 / 大屏 / 看板，或修改已有驾驶舱时使用。包含模板选择、data-slot 填写、artifactApp 运行时约束、HTML 文件预览和发布前用户确认。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: SKILL_NAME,
  source: 'bundled' as const,
  resourceBase: { kind: 'directory' as const, path: SKILL_ROOT },
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_FILE,
  metadata: { permissions: ['artifact-app:create'] },
})

/**
 * Register the host routes, the model tools and the authoring skill.
 * @param ctx - DSH host context with web routes, tools, approval and credentials.
 * @param config - DataOps origin, credential ref and HTML limits.
 */
export function apply(ctx: Context, config: ConfigValues): void {
  const tokens: TokenSource = {
    resolve: async () => (await ctx.credentials.resolve(credentialRef(config.credentialRef)))?.value,
  }
  const api = new ArtifactApi(config.baseUrl, tokens, config.requestTimeoutMs)
  const hub = new OpenCockpitHub(ctx.logger)
  const permissions = new PermissionCache(api)
  const previewIds = new Map<string, string>()
  let runtimeScript: Promise<string> | undefined
  let echartsScript: Promise<string> | undefined
  const runtime = (): Promise<string> => (runtimeScript ??= api.runtimeScript())
  const echarts = (): Promise<string> => (echartsScript ??= api.echartsScript())

  ctx.effect(() => () => hub.dispose(), 'artifact-app: SSE clients')

  // Client config: absolute render and gateway addresses for the current browser.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_PATH,
    handler: (request, response) => {
      // 相对路径：iframe 与网关都按**页面自身的 origin** 解析。绝对地址在反向代理后面
      // 会指到内部 host（例如 127.0.0.1:3080），浏览器那头直接连不上。
      writeJson(response, 200, {
        renderBaseUrl: RENDER_PATH,
        gatewayBaseUrl: GATEWAY_PATH + '/api/artifact-apps',
        tabType: ARTIFACT_TAB_TYPE,
        dataopsWebBaseUrl: config.webBaseUrl.trim() || requestOrigin(request),
      })
    },
  }), 'artifact-app: config route')

  // The tab posts this token into the sandboxed viewer; it never enters the HTML text.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TOKEN_PATH,
    handler: async (_request, response) => {
      try {
        writeJson(response, 200, { token: await api.token() })
      } catch (error) {
        writeJson(response, 401, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'artifact-app: token route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_EVENTS_PATH,
    handler: (request, response) => hub.subscribe(request, response),
  }), 'artifact-app: open events route')

  // App list proxy for the sidebar tab, so the browser never holds the API token for reads.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: APPS_PATH,
    handler: async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://dsh.internal')
        const page = await api.listApps({
          q: url.searchParams.get('q') ?? undefined,
          catalog: url.searchParams.get('catalog') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
          page: 1,
          pageSize: Math.max(1, Math.min(100, Number(url.searchParams.get('pageSize') ?? 50) || 50)),
        })
        writeJson(response, 200, page)
      } catch (error) {
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'artifact-app: apps route')

  // Cockpit templates/components for the same tab. Reads go through the workspace credential,
  // like the app list, so the browser never needs a DataOps token to browse either library.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TEMPLATES_PATH,
    handler: async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://dsh.internal')
        const appType = url.searchParams.get('appType') === 'COMPONENT' ? 'COMPONENT' : 'COCKPIT'
        const rows = await api.listTemplates(appType)
        writeJson(response, 200, { items: rows })
      } catch (error) {
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'artifact-app: templates route')

  // File viewer drafts: one draft per workspace path, updated as the file changes.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREVIEW_PATH,
    handler: async (request, response) => {
      if (request.method !== 'POST') { writeJson(response, 405, { error: 'POST only' }); return }
      try {
        const body = await readJsonBody(request, config.htmlMaxBytes + 64 * 1024)
        const path = typeof body.path === 'string' ? body.path : ''
        const html = typeof body.html === 'string' ? body.html : ''
        if (path === '' || html === '') throw new Error('path 和 html 都是必填项')
        assertCockpitHtml(html, config.htmlMaxBytes)
        const existing = previewIds.get(path)
        const result = await api.preview({
          ...(existing === undefined ? {} : { artifactId: existing }),
          html,
          name: typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : basename(path).replace(/\.html?$/iu, ''),
          description: '驾驶舱文件预览',
          ...(typeof body.templateId === 'string' ? { templateId: body.templateId } : {}),
          ...(typeof body.templateVersion === 'string' ? { templateVersion: body.templateVersion } : {}),
        })
        previewIds.set(path, result.id)
        writeJson(response, 200, { artifactId: result.id, version: result.version, created: result.created })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeJson(response, error instanceof Error && 'code' in error && error.code === 'TEMPLATE_CONTRACT_MISSING' ? 422 : 400, { error: message })
      }
    },
  }), 'artifact-app: preview route')

  // Render route. Static segments live under their own exact paths, so `:id` cannot
  // swallow them; this prefix owns only `/render/...`.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: RENDER_PATH,
    handler: async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://dsh.internal')
        const rest = url.pathname.slice(RENDER_PATH.length).replace(/^\/+/u, '')
        const id = decodeURIComponent(rest)
        // Two address forms: `<appId>` renders a published cockpit and `template/<id>` renders a
        // template skeleton. Reject anything else so neither branch can read outside its id.
        const templatePrefix = 'template/'
        const templateId = id.startsWith(templatePrefix) ? id.slice(templatePrefix.length) : undefined
        const targetId = templateId ?? id
        if (targetId === '' || targetId.includes('/') || targetId.includes('\\') || targetId.includes('..') || targetId.startsWith('.')) {
          writeJson(response, 400, { error: '缺少驾驶舱 id' }); return
        }
        let body: { html: string; templateId?: string | null }
        let isComponent = false
        if (templateId === undefined) {
          body = await api.getAppHtml(targetId)
        } else {
          const meta = await api.getTemplate(targetId)
          isComponent = meta.appType === 'COMPONENT'
          body = { html: (await api.getTemplateHtml(targetId)).html, templateId }
        }
        // 组件是参考实现，没有 artifactApp 契约标记；只有应用/驾驶舱模板才校验。
        if (!isComponent) assertCockpitHtml(body.html, config.htmlMaxBytes)
        // 把 asset://<逻辑名> 解析成素材 URL（shared 优先，模板素材需模板 id；当前应用没记模板时退化为 shared）
        const logicalNames = [...new Set([...body.html.matchAll(/asset:\/\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,62})/gu)].map((m) => m[1]))]
        let resolvedHtml = body.html
        if (logicalNames.length > 0) {
          // 解析顺序：模板素材优先（模板包里的 assets/），再用 shared 兜底。
          const assetTemplateId = (body as { templateId?: string | null }).templateId ?? undefined
          const templateUrls = assetTemplateId === undefined
            ? {}
            : await api.resolveAssets(logicalNames, 'template', assetTemplateId).catch(() => ({} as Record<string, string>))
          const rest = logicalNames.filter((name) => templateUrls[name] === undefined)
          const sharedUrls = rest.length === 0 ? {} : await api.resolveAssets(rest, 'shared').catch(() => ({} as Record<string, string>))
          for (const [name, url] of Object.entries({ ...sharedUrls, ...templateUrls })) {
            resolvedHtml = resolvedHtml.split('asset://' + name).join(url)
          }
        }
        const withRuntime = injectCockpitRuntime(resolvedHtml, {
          runtimeJs: await runtime(),
          ...(config.injectRuntime ? { echartsJs: await echarts() } : {}),
        })
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': cockpitCsp(requestOrigin(request)),
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        })
        response.end(withRuntime)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        response.end('驾驶舱渲染失败：' + message)
      }
    },
  }), 'artifact-app: render route')

  // Gateway: the sandboxed page's only network outlet. Only query/call-api are proxied.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: GATEWAY_PATH,
    handler: async (request, response) => {
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, accept, x-dataops-token',
        'access-control-max-age': '600',
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204, cors)
        response.end()
        return
      }
      try {
        const url = new URL(request.url ?? '/', 'http://dsh.internal')
        const upstreamPath = url.pathname.slice(GATEWAY_PATH.length)
        const upstream = upstreamPath + url.search
        // 驾驶舱运行时需要的调用：详情（配置）、取数、调 API、导出 HTML/zip。
        // 只放 query|call-api 会把「打开驾驶舱」时那次 GET /<id> 也挡掉，表现为整个页面
        // 渲染出来了但满屏「数据加载失败」。
        // 允许：详情、取数、调 API、导出（html/export），以及导出时要内联的运行时资源。
        // 「导出」对话框会拉 export?mode=…；少放行任何一个都会让导出静默失败（点击无下载）。
        if (!/^\/api\/artifact-apps\/(?:[^/]+(?:\/(?:query|call-api|html|export))?|(?:runtime|echarts)\.js)$/u.test(upstreamPath)) {
          response.writeHead(403, { ...cors, 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ error: '网关只代理驾驶舱取数接口' }))
          return
        }
        // 优先用运行时透传的调用者 token：本路径经 workspace 网关时，authorization 已被
        // 换成 workspace 的 runtime token，那个 token 没有 /query 的权限。
        const forwarded = request.headers['x-dataops-token']
        const authorization = (typeof forwarded === 'string' && forwarded.trim() !== '')
          ? `Bearer ${forwarded.trim()}`
          : request.headers.authorization
        const rawBody = request.method === 'POST'
          ? await readJsonBody(request, 1024 * 1024) as Record<string, unknown>
          : undefined
        // body 里的 __dataopsToken 是调用者身份：请求头经 workspace 网关会被换成 runtime token。
        const bodyToken = typeof rawBody?.__dataopsToken === 'string' ? rawBody.__dataopsToken : undefined
        if (rawBody !== undefined) delete rawBody.__dataopsToken
        const effectiveAuth = bodyToken !== undefined && bodyToken !== ''
          ? `Bearer ${bodyToken}`
          : authorization
        // 兜底：调用方没有带 token 时用本工作区的同一份 credential 补 Authorization。
        // 门户 /api/artifact-apps/<id>/query 的 AuthGuard 只认 Bearer；缺头会 401。
        let gatewayAuth = typeof effectiveAuth === 'string' && effectiveAuth.trim() !== ''
          ? effectiveAuth
          : undefined
        if (gatewayAuth === undefined) {
          try {
            gatewayAuth = 'Bearer ' + await api.token()
            ctx.logger.warn('artifact-app: gateway used the workspace credential for ' + upstream)
          } catch { /* 无 credential 时交给 DataOps 返回 401 */ }
        }
        const init: RequestInit = {
          method: request.method,
          ...(rawBody !== undefined ? { body: JSON.stringify(rawBody) } : {}),
        }
        const result = await api.gateway(upstream, init, gatewayAuth)
        response.writeHead(result.status, {
          ...cors,
          'content-type': result.contentType,
          'cache-control': 'no-store',
        })
        response.end(result.body)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        response.writeHead(502, { ...cors, 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: message }))
      }
    },
  }), 'artifact-app: gateway route')

  registerCockpitTools({ ctx, api, hub, config })

  // Skill disclosure follows the create capability; a user without it never sees the skill.
  const skill = buildSkill()
  const provider = {
    name: SKILL_NAME,
    list: async () => (await permissions.canCreate() ? [skill] : []),
    async get() {
      return { ...skill, content: await readFile(SKILL_FILE, 'utf8') }
    },
  }
  ctx.skills.registerProvider(() => provider)
}