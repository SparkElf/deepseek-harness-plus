/**
 * Host entry for `@sparkelf/dsh-dataops-im`.
 *
 * One package, two modes:
 * - `admin`: the settings page talks to the DataOps `/api/im/bots` API through the same-origin
 *   proxy registered by `src/admin/proxy.ts`. dsh-im is never imported.
 * - `connector`: additionally loads the pinned `@xmanrui/dsh-im@5.10.0` host, with the three
 *   `dsh_im_*` tools behind a per-Session gate and every IM management RPC behind a local
 *   403 unless the current DataOps principal holds `system:im:manage` or an administrator role.
 *
 * The root plugin injects only `webServer` so an admin workspace never waits for connector
 * services. Connector mode mounts an inner plugin carrying its own inject list.
 *
 * @module @sparkelf/dsh-dataops-im
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { registerAdminProxy } from './admin/proxy.ts'
import { applyConnector } from './connector/index.ts'
import { DEFAULT_ADMIN_POLICY } from './auth.ts'

/** Plugin id used by the profile patch. */
export const name = 'dataops-im'

/** Admin mode needs only the web server; connector services live on the inner plugin. */
export const inject = ['webServer']

/** Which half of the package is active. */
export type ImMode = 'admin' | 'connector'

/** Configuration delivered by the profile patch row. */
export interface Config {
  /** `admin` never loads dsh-im; `connector` mounts it in this profile. */
  mode: ImMode
  /** DataOps API origin, without `/api`. */
  baseUrl: string
  /** DSH credential reference holding the current DataOps access JWT. */
  credentialRef: string
  /** Permission keys that grant IM administration. */
  adminPermissions: string[]
  /** Role keys or display names that grant IM administration. */
  adminRoles: string[]
  /**
   * IM 连接器工作区的 DSH origin（仅 admin 模式需要）。
   *
   * 用于在管理端设置页读取连接器内存里的“待绑定发送者”。留空时页面显示空列表；
   * 连接器工作区本身由 `/api/dsh-dataops-im/identity/pending` 直接提供数据。
   */
  connectorUrl: string
  /** 内部诊断开关：是否在设置页显示“待绑定发送者”列表；默认关闭。 */
  showPendingSenders: boolean
  /**
   * Explicit opt-in to dsh-im's original always-on tool registration.
   *
   * Defaults to `false`: the three tools are registered with a per-Session condition and are
   * absent from ordinary Sessions. Set this only for a dedicated comparison profile.
   */
  registerTools: boolean
  /** Upstream dsh-im host configuration, passed through unchanged. */
  dshIm: Record<string, unknown>
}

/** Schemastery parser for the profile row. */
export const Config: z<Config> = z.object({
  mode: z.union([z.const('admin'), z.const('connector')]).default('admin').description(
    'admin = 设置页/same-origin proxy only; connector = 加载 dsh-im 并按会话门控工具',
  ),
  baseUrl: z.string().default('http://host.docker.internal:3101').description(
    'DataOps 后端 origin，例如 http://127.0.0.1:3101',
  ),
  credentialRef: z.string().role('credential-ref').default('DATAOPS_ACCESS_TOKEN'),
  adminPermissions: z.array(z.string()).default([...DEFAULT_ADMIN_POLICY.permissions]),
  adminRoles: z.array(z.string()).default([...DEFAULT_ADMIN_POLICY.roles]),
  connectorUrl: z.string().default('').description(
    'IM 连接器工作区 DSH origin，例如 http://172.17.0.9:3080；仅 admin 模式读取待绑定发送者时使用',
  ),
  showPendingSenders: z.boolean().default(false).description(
    '内部诊断开关：默认关闭；打开后在设置页显示待绑定发送者列表',
  ),
  registerTools: z.boolean().default(false),
  dshIm: z.any().default({}),
})

/** Public re-export so connector code and tests share one policy default. */
export { DEFAULT_ADMIN_POLICY }

/**
 * 私聊路由的诊断/测试接缝。
 *
 * connector 模式在运行时用这些实现接管 `chattype === 'single'`；导出它们是为了让
 * 3000 的合成帧证据脚本直接调用生产实现，而不是复制一份逻辑。
 */
export {
  createPrivateChatRuntime,
  createDirectChatHandler,
  PrivateChatRouter,
  PrivateChatError,
} from './connector/private-chat.ts'

/**
 * 企微 GenUI 渲染策略。
 *
 * 群聊共享 session 在调用 `group-chat.ts` 的投递前，用它把 assistant 文本渲染成
 * `text | image` segments；`audienceHint` 必须由调用方在渲染前判定。
 */
export {
  renderAssistantReply,
  resolveReplyAudience,
  stripGenUiFences,
  sanitizeGenUiPreview,
} from './connector/render-policy.ts'
export type {
  RenderedReply,
  ReplyAudience,
  ReplySegment,
  RenderContext,
} from './connector/render-policy.ts'

/**
 * Mount the wrapper.
 *
 * The admin proxy is registered in both modes: it is the same-origin read/write surface for the
 * settings page and forwards the caller's own bearer to DataOps, which remains the authority.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await registerAdminProxy(ctx, {
    baseUrl: config.baseUrl,
    connectorUrl: config.connectorUrl,
    showPendingSenders: config.showPendingSenders,
  })
  if (config.mode !== 'connector') return

  const logger = typeof ctx.logger === 'function'
    ? ctx.logger(name)
    : (ctx.logger ?? console)
  const fiber: Fiber = ctx.plugin({
    name: 'dataops-im-connector',
    inject: ['credentials', 'connection', 'tools', 'systemPrompt', 'sessions', 'typertGateway', 'webServer'],
    apply: (inner: Context) => applyConnector(inner, config, logger),
  })
  await fiber.await()
}