/**
 * Connector-mode host wiring.
 *
 * This module is imported only when `mode=connector`; the admin-mode entry never reaches the
 * dynamic `@xmanrui/dsh-im` import below, so an admin profile cannot load the channel host by
 * accident.
 *
 * @module @sparkelf/dsh-dataops-im/connector
 */

import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_ADMIN_POLICY, ScopeResolver } from '../auth.ts'
import { installAdminRoutes, installImToolGate, installManagementRpcGate } from '../gating.ts'
import { WecomIdentityBridge } from './identity.ts'
import { privateChatRuntimeStatus } from './private-chat.ts'
import {
  createGroupChatRuntime,
  groupChatFrameStatus,
  groupChatRuntimeStatus,
  groupChatDeliveryStatus,
  groupChatErrorStatus,
  groupChatSessionStatus,
  probeGroupChatFrame,
  type GroupProbeInput,
} from './group-chat.ts'
import { historySyncConfigFromEnv, historySyncStatus } from './history-sync.ts'
import { installGroupCredentialScope } from './group-turn-actor.ts'

/** Configuration for connector mode; admin fields keep their admin-mode meaning. */
export interface ConnectorConfig {
  /** DataOps API origin used for `/api/ai/review/context` and the bot list. */
  readonly baseUrl: string
  /** DSH credential reference holding the current DataOps access JWT. */
  readonly credentialRef: string
  /** Permission keys that grant IM administration. */
  readonly adminPermissions: readonly string[]
  /** Role keys or display names that grant IM administration. */
  readonly adminRoles: readonly string[]
  /** Explicit opt-in to upstream always-on tool registration; default false. */
  readonly registerTools: boolean
  /** Upstream dsh-im host configuration, passed through unchanged. */
  readonly dshIm: Record<string, unknown>
}

/** Structural contract of the pinned upstream host module. */
interface DshImModule {
  apply(ctx: Context, config?: Record<string, unknown>): Promise<void>
}

/** Logging surface kept narrow so the module is easy to exercise in tests. */
export interface ConnectorLogger {
  info?(message: string): void
  warn(message: string): void
  error?(message: string): void
}

/**
 * Mount dsh-im behind the local gates.
 *
 * Order is part of the contract: the tool gate must own `tools.register` before dsh-im
 * activates, and the RPC gate must own `connection.fetch.register` before dsh-im registers any
 * management channel.
 *
 * @param ctx - Host context carrying credentials, connection, tools and systemPrompt.
 * @param config - connector configuration from the profile row.
 * @param logger - plugin logger.
 */
export async function applyConnector(ctx: Context, config: ConnectorConfig, logger: ConnectorLogger): Promise<void> {
  const baseUrl = safeOrigin(config.baseUrl, logger)
  const resolver = new ScopeResolver(ctx, {
    baseUrl,
    credentialRef: config.credentialRef,
    policy: { permissions: config.adminPermissions, roles: config.adminRoles },
    logger: { warn: message => logger.warn(message) },
  })
  ctx.effect(() => () => resolver.dispose(), 'dataops-im: scope resolver')
  if (typeof ctx.on === 'function') {
    ctx.on('credentials/reference-updated', reference => {
      if (String(reference) !== config.credentialRef) return
      void resolver.refresh(true)
    })
  }
  void resolver.start()

  // 群 turn 内的原生 DataOps 插件直接解析 DATAOPS_ACCESS_TOKEN；这里把群 session（含
  // fork 分支/子代理）的解析替换成当前 sender 的 scoped token，缺少 actor 时 fail closed。
  ctx.effect(() => installGroupCredentialScope(ctx, config.credentialRef), 'dataops-im: group credential scope')

  const toolGate = installImToolGate(ctx, {
    registerTools: config.registerTools,
    isAdmin: () => resolver.isAdmin(),
    logger: { warn: message => logger.warn(message) },
  })
  ctx.effect(() => toolGate, 'dataops-im: dsh-im tool gate')

  const rpcGate = installManagementRpcGate(ctx, {
    resolver,
    logger: { warn: message => logger.warn(message) },
  })
  ctx.effect(() => rpcGate, 'dataops-im: management RPC gate')

  // 身份桥必须早于 dsh-im 激活：dsh-im 会在对话绑定/新会话时同步发事件，订阅晚一步就会
  // 漏掉第一条消息的身份。这里先建桥，再动态加载上游通道。
  const identity = new WecomIdentityBridge(ctx, {
    baseUrl,
    credentialRef: config.credentialRef,
    logger: { info: message => logger.info?.(message), warn: message => logger.warn(message), error: message => logger.error?.(message) },
  })
  ctx.effect(() => identity.start(), 'dataops-im: wecom identity bridge')

  for (const dispose of installAdminRoutes(ctx, {
    resolver,
    baseUrl,
    mode: 'connector',
    logger,
    identityStatus: sessionId => identity.status(sessionId),
    identityPending: () => identity.listPending(),
  })) {
    ctx.effect(() => dispose, 'dataops-im: admin route')
  }

  // 私聊和群聊都必须落在提问者自己的默认工作区：用 dsh-im 的 `internals.Runtime` 接缝换入
  // Runtime 子类。私聊只改写 `chattype === 'single'`；群聊把普通消息分流到按
  // `(botId, chatId, senderId)` 建的独立 session，命令仍走原 Bridge。构造失败时直接让
  // connector 启动失败（fail closed），避免敏感结果悄悄回落到机器人工作区。
  const imChatRuntime = await createGroupChatRuntime({
    ctx,
    baseUrl,
    credentialRef: config.credentialRef,
    historySync: historySyncConfigFromEnv(),
    logger: {
      info: message => logger.info?.(message),
      warn: message => logger.warn(message),
      error: message => logger.error?.(message),
    },
  })
  // 只读诊断：证明当前 connector 进程确实构造了接管私聊/群聊的 Runtime（不返回任何凭据）。
  const webServer = (ctx as unknown as {
    webServer?: { register(route: unknown): () => void }
  }).webServer
  if (webServer !== undefined && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/integrations/dataops/private-chat',
      handler: (request: {
        method?: string
        url?: string
        on?(event: string, listener: (chunk?: unknown) => void): void
        destroy?(): void
      }, response: {
        writeHead(status: number, headers: Record<string, string>): void
        end(body?: string): void
      }) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        if (request.method === 'POST' && path === '/integrations/dataops/private-chat/probe') {
          // 仅证据环境显式开启；默认不注册任何可触发 agent turn 的写入口。
          if (process.env.DATAOPS_IM_GROUP_PROBE !== '1') {
            response.writeHead(404, { 'content-length': '0' })
            response.end()
            return
          }
          void readProbeBody(request).then(async (body) => {
            try {
              const result = await probeGroupChatFrame(body)
              writeJson(response, 200, result)
            } catch (error) {
              writeJson(response, 500, {
                ok: false,
                code: error instanceof Error && 'code' in error ? String(error.code) : 'GROUP_PROBE_FAILED',
                message: error instanceof Error ? error.message : String(error),
              })
            }
          }).catch(error => writeJson(response, 400, {
            ok: false,
            code: 'GROUP_PROBE_BAD_REQUEST',
            message: error instanceof Error ? error.message : String(error),
          }))
          return
        }
        if (request.method !== 'GET' || path !== '/integrations/dataops/private-chat/status') {
          response.writeHead(404, { 'content-length': '0' })
          response.end()
          return
        }
        const groupRuntimes = groupChatRuntimeStatus()
        const groupFrames = groupChatFrameStatus()
        const groupSessions = groupChatSessionStatus()
        const groupErrors = groupChatErrorStatus()
        const groupDelivery = groupChatDeliveryStatus()
        const history = historySyncStatus()
        // 归档集合只读暴露，供证据确认 sender_only fork child 已被移出可见面。
        // 通过 ctx.get 取可选服务：直接访问未注入的服务属性会让整条路由抛错（表现为 400）。
        const registry = optionalService(ctx, 'workspaceRegistry') as { archivedSessionIds?: unknown } | undefined
        const archivedSessions = registry?.archivedSessionIds
        writeJson(response, 200, {
          ok: true,
          archivedSessions: Array.isArray(archivedSessions) ? archivedSessions : [],
          // 私聊与群聊共用同一个 Runtime 子类；`runtimes` 保持旧字段形状，`groupRuntimes`
          // 单独暴露群聊安装状态，便于 3000 证据脚本区分。
          runtimes: [...privateChatRuntimeStatus(), ...groupRuntimes],
          groupRuntimes,
          groupFrames,
          groupSessions,
          groupErrors,
          groupDelivery,
          historySync: history,
        })
      },
    }), 'dataops-im: private-chat status route')
  }

  const dshImConfig: Record<string, unknown> = { ...(config.dshIm ?? {}) }
  const wecomConfig: Record<string, unknown> = {
    ...(typeof dshImConfig.wecom === 'object' && dshImConfig.wecom !== null
      ? dshImConfig.wecom as Record<string, unknown>
      : {}),
  }
  const wecomInternals: Record<string, unknown> = {
    ...(typeof wecomConfig.internals === 'object' && wecomConfig.internals !== null
      ? wecomConfig.internals as Record<string, unknown>
      : {}),
  }
  wecomInternals.Runtime = imChatRuntime
  wecomConfig.internals = wecomInternals
  dshImConfig.wecom = wecomConfig

  const upstream = await import('@xmanrui/dsh-im') as unknown as DshImModule
  await upstream.apply(ctx, dshImConfig)
  logger.info?.('dataops-im: connector mode; dsh-im loaded with per-Session tool gating, private-chat and group-chat routing')
}

/** 读取可选 Cordis 服务；未注入/不可用时返回 undefined，不让诊断路由整体失败。 */
function optionalService(ctx: Context, name: string): unknown {
  try {
    const holder = ctx as unknown as { get?(serviceName: string): unknown; [key: string]: unknown }
    if (typeof holder.get === 'function') {
      const value = holder.get.call(ctx, name)
      if (value !== undefined) return value
    }
    return holder[name]
  } catch {
    return undefined
  }
}

/** 写一个 JSON 响应；只用于本地诊断路由。 */
function writeJson(
  response: { writeHead(status: number, headers: Record<string, string>): void; end(body?: string): void },
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(payload)),
  })
  response.end(payload)
}

/**
 * 读取证据探针的 JSON body（上限 64 KiB）。
 *
 * 只接受显式字段，避免把任意对象塞进 Router；`botId` 缺省时用当前进程唯一的群聊 Runtime。
 */
function readProbeBody(request: {
  on?(event: string, listener: (chunk?: unknown) => void): void
  destroy?(): void
}): Promise<GroupProbeInput> {
  return new Promise((resolve, reject) => {
    let raw = ''
    let size = 0
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('探针请求体读取超时'))
    }, 10_000)
    timer.unref?.()
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    request.on?.('data', (chunk?: unknown) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '')
      size += Buffer.byteLength(text)
      if (size > 64 * 1024) {
        request.destroy?.()
        fail(new Error('探针请求体过大'))
        return
      }
      raw += text
    })
    request.on?.('end', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        reject(new Error('探针请求体不是 JSON'))
        return
      }
      const body = parsed as Record<string, unknown>
      const text = (key: string): string => typeof body[key] === 'string' ? String(body[key]).trim() : ''
      const chatId = text('chatId')
      const senderId = text('senderId')
      const content = text('text')
      if (chatId === '' || senderId === '' || content === '') {
        reject(new Error('chatId、senderId、text 不能为空'))
        return
      }
      if (chatId.length > 200 || senderId.length > 200 || content.length > 8_000) {
        reject(new Error('chatId、senderId 或 text 过长'))
        return
      }
      resolve({
        chatId,
        senderId,
        text: content,
        ...text('botId') === '' ? {} : { botId: text('botId') },
        ...text('senderName') === '' ? {} : { senderName: text('senderName') },
        ...text('messageId') === '' ? {} : { messageId: text('messageId') },
      })
    })
    request.on?.('error', (error?: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

/** Parse one configured origin, falling back to the default DataOps API origin. */
function safeOrigin(value: string, logger: { warn(message: string): void }): string {
  try {
    return new URL(value).origin
  } catch {
    logger.warn(`dataops-im: invalid baseUrl ${JSON.stringify(value)}; using the default`)
    return 'http://host.docker.internal:3101'
  }
}

/** Re-export the policy default so the admin entry and documentation share one spelling. */
export { DEFAULT_ADMIN_POLICY }