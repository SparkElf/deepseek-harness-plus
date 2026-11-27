/**
 * 「IM 机器人」设置页的同源代理（admin 模式）。
 *
 * 只有一件事：把 DSH 设置页的请求转发给 DataOps `/api/im/bots*`，并原样带回状态码与响应体。
 * 它不加载 IM 通道、不注册工具/技能/系统提示、不持有 Secret；授权由 DataOps 的
 * `system:im:manage` 判定，本模块只转发调用者自己的 Bearer，不判断也不缓存权限。
 *
 * @module admin/proxy
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 同源代理路径前缀；`/<bot id>/test` 之类的后缀原样拼到 DataOps 路由后面。 */
export const IM_BASE_PATH = '/integrations/dataops/im'

/** 代理需要的最小配置。 */
export interface ImBotProxyConfig {
  /** DataOps 后端 origin（含端口，不含 `/api`）。 */
  baseUrl: string
  /**
   * IM 连接器工作区的 DSH origin（admin 模式查看“待绑定发送者”时使用）。
   *
   * 待绑定发送者只存在于连接器进程内存里，DataOps 后端没有这条数据；管理端通过它把
   * 管理员的 Bearer 原样转给连接器，由连接器侧再做一次管理员校验。留空表示当前部署
   * 没有可查询的连接器，页面显示空列表而不是报错。
   */
  connectorUrl?: string
  /** 内部诊断开关；默认 false，设置页不渲染待绑定发送者列表。 */
  showPendingSenders?: boolean
}

/** 请求体上限：批量绑定支持 CSV/JSON，管理表单本身远小于这个尺寸。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** 上游超时：连接测试本身可能等平台 6s，这里留出余量。 */
const UPSTREAM_TIMEOUT_MS = 20_000

/**
 * 读出调用者的 Bearer，不解释、不刷新。
 * @param request - 网关转发进来的请求。
 * @returns 原始 Authorization 头；缺失时 null。
 */
function authorizationHeader(request: IncomingMessage): string | null {
  const value = request.headers.authorization?.trim() ?? ''
  return value.startsWith('Bearer ') && value.length > 'Bearer '.length ? value : null
}

/**
 * 读完整个请求体。
 * @param request - 请求流。
 * @returns UTF-8 文本；超限返回 null。
 */
async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.length
    if (total > MAX_BODY_BYTES) return null
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 写一个 JSON 响应。
 * @param response - 原生响应。
 * @param status - HTTP 状态码。
 * @param body - 可 JSON 化的响应体。
 */
function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

/** 页面消费的 capability 结果；`available:false` 表示当前部署没有 IM 管理接口。 */
export interface ImCapabilityBody {
  available: boolean
  allowed: boolean
  reason?: string
}

/** capability 降级响应；HTTP 始终 200，浏览器不会把它记成 5xx。 */
export interface ImCapabilityResponse {
  status: number
  body: ImCapabilityBody
}

/**
 * 把上游 capability 响应折成页面可消费的结果。
 *
 * 404/5xx 是**部署差异**而不是页面错误：旧 backend 没有 `/api/im/capability`，
 * 新版代理返回 502 也属于同类。这里把它们统一折成 `{available:false, reason}` 的 200，
 * 让设置页安静地隐藏入口；401/403 仍说明接口存在，只是当前账号不能管理。
 *
 * @param status - 上游 HTTP 状态码。
 * @param text - 上游响应文本。
 * @returns 状态码与降级/正常响应体。
 */
export function capabilityResponse(status: number, text: string): ImCapabilityResponse {
  if (status === 401 || status === 403) {
    return {
      status: 200,
      body: {
        available: true,
        allowed: false,
        reason: status === 401 ? 'unauthenticated' : 'forbidden',
      },
    }
  }
  if (status !== 200) {
    return {
      status: 200,
      body: {
        available: false,
        allowed: false,
        reason: `第 ${status} 号响应：DataOps 未提供 IM capability 接口`,
      },
    }
  }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    parsed = null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      status: 200,
      body: { available: false, allowed: false, reason: 'IM capability 响应不可解析' },
    }
  }
  const record = parsed as { allowed?: unknown; available?: unknown; reason?: unknown }
  return {
    status: 200,
    body: {
      available: record.available !== false,
      allowed: record.allowed === true,
      ...(typeof record.reason === 'string' && record.reason !== '' ? { reason: record.reason } : {}),
    },
  }
}

/**
 * 解析可选的上游 origin；空值或非法值返回 undefined。
 * @param value - 配置里的 URL。
 */
function safeOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? ''
  if (trimmed === '') return undefined
  try {
    return new URL(trimmed).origin
  } catch {
    return undefined
  }
}

/**
 * 注册 `/integrations/dataops/im-bots` 前缀代理。
 *
 * 方法刻意只有管理面用到的四个（GET/POST/PATCH/DELETE），路径只允许机器人 id 形状的段，
 * 避免这个代理变成任意 DataOps 请求通道。
 *
 * @param ctx - Cordis 宿主上下文（需要 `webServer`）。
 * @param config - DataOps baseUrl。
 */
export async function registerAdminProxy(ctx: Context, config: ImBotProxyConfig): Promise<void> {
  const origin = new URL(config.baseUrl).origin

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: IM_BASE_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const authorization = authorizationHeader(request)
      if (authorization === null) {
        writeJson(response, 401, { error: 'DataOps 会话缺失：请从万相门户进入工作台' })
        return
      }
      const method = (request.method ?? 'GET').toUpperCase()
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
        response.writeHead(405, { allow: 'GET, POST, PATCH, DELETE', 'content-length': '0' })
        response.end()
        return
      }
      const parsed = new URL(request.url ?? '/', 'http://localhost')
      const suffix = parsed.pathname.startsWith(IM_BASE_PATH) ? parsed.pathname.slice(IM_BASE_PATH.length) : ''
      const search = parsed.search
      // capability 是设置页的可见性探针：旧 backend 没有这条路由时返回可消费的降级体，
      // 而不是把 404/502 透给浏览器。详见 {@link capabilityResponse}。
      if (suffix === '/capability') {
        if (method !== 'GET') {
          response.writeHead(405, { allow: 'GET', 'content-length': '0' })
          response.end()
          return
        }
        try {
          const upstream = await fetch(new URL('/api/im/capability', origin), {
            headers: { accept: 'application/json', authorization },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          })
          const text = await upstream.text()
          const result = capabilityResponse(upstream.status, text)
          writeJson(response, result.status, result.body)
        } catch (error) {
          ctx.logger.warn('dataops-im: IM capability probe failed', error)
          writeJson(response, 200, {
            available: false,
            allowed: false,
            reason: 'DataOps 后端不可达',
          })
        }
        return
      }
      // 客户端只需要知道是否渲染内部诊断面板，不需要读 DataOps。
      if (suffix === '/features') {
        writeJson(response, 200, { showPendingSenders: config.showPendingSenders === true })
        return
      }
      // 待绑定发送者不在 DataOps 后端：它只存在于连接器进程内存里。管理员打开管理端
      // 设置页时，这里把同一个 Bearer 转给连接器工作区的 DSH，由连接器侧做最终校验。
      if (suffix === '/identity/pending') {
        if (method !== 'GET') {
          response.writeHead(405, { allow: 'GET', 'content-length': '0' })
          response.end()
          return
        }
        const connectorOrigin = safeOrigin(config.connectorUrl)
        if (connectorOrigin === undefined) {
          writeJson(response, 200, {
            ok: true,
            items: [],
            connector: false,
            message: '当前工作区不是 IM 连接器工作区，未配置待绑定发送者来源。',
          })
          return
        }
        try {
          const upstream = await fetch(new URL('/api/dsh-dataops-im/identity/pending', connectorOrigin), {
            headers: { accept: 'application/json', authorization },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          })
          const text = await upstream.text()
          response.writeHead(upstream.status, {
            'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(text),
          })
          response.end(text)
        } catch (error) {
          ctx.logger.warn('dataops-im: IM pending-sender proxy failed', error)
          writeJson(response, 502, { ok: false, error: { code: 'CONNECTOR_UNREACHABLE', message: 'IM 连接器工作区不可达' } })
        }
        return
      }
      // 只放行管理面用到的路由：`/bots[/<id>[/test]]`、`/identity/users[/<id>]`
      // 与 `/identity/bulk-bind`。代理不是通用通道，`..`、`//`、`?` 一律不放行。
      const botRoute = /^\/bots(?:\/[A-Za-z0-9-]+){0,2}$/.test(suffix)
      const identityRoute = /^\/identity\/users(?:\/[A-Za-z0-9-]+)?$/.test(suffix)
      const bulkIdentityRoute = suffix === '/identity/bulk-bind'
      if (!botRoute && !identityRoute && !bulkIdentityRoute) {
        writeJson(response, 400, { error: '非法的 IM 管理路径' })
        return
      }
      const body = method === 'GET' || method === 'DELETE' ? '' : await readBody(request)
      if (body === null) {
        writeJson(response, 413, { error: '请求体过大' })
        return
      }
      try {
        const upstream = await fetch(new URL(`/api/im${suffix}${search}`, origin), {
          method,
          headers: {
            authorization,
            ...(body === '' ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === '' ? {} : { body }),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        })
        const text = await upstream.text()
        response.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(text),
        })
        response.end(text)
      } catch (error) {
        ctx.logger.warn('dataops-im: IM bot proxy failed', error)
        writeJson(response, 502, { error: 'DataOps 后端不可达', code: 'DATAOPS_UNREACHABLE' })
      }
    },
  }), 'dataops-im: IM bot management proxy')
}
/**
 * 过渡别名：当前 `src/index.ts` 仍以旧名字调用。`im-connector-fork-box` 接管入口后应改调
 * {@link registerAdminProxy}，届时删除本别名。
 *
 * @deprecated 用 {@link registerAdminProxy}。
 */
export const registerImBotProxy = registerAdminProxy
