/**
 * Local gates for the IM connector.
 *
 * Two boundaries are enforced here, both local to this DSH Host:
 * - the model-facing tool list: the three `dsh_im_*` tools are registered with a step-time
 *   condition, so an ordinary Session never receives them;
 * - the IM management HTTP/RPC surface: every `/api/dsh-im/*` management route answers 403
 *   unless the current DataOps principal holds IM administration.
 *
 * The delivery ingress route (`/api/dsh-im/delivery/messages`) is intentionally not gated: bot
 * channels must keep delivering messages for ordinary users.
 *
 * @module gating
 */

import type { Context } from '@deepseek-ai/cordis'
import { bearerToken, isScopeActor, type ScopeResolver } from './auth.ts'

/** The three tools dsh-im 5.10.0 registers globally. */
export const IM_TOOL_NAMES: ReadonlySet<string> = new Set([
  'dsh_im_group_history',
  'dsh_im_group_file',
  'dsh_im_return_file',
])

/** The one IM HTTP route that is data-plane ingress rather than administration. */
export const DELIVERY_INGRESS_PATH = '/api/dsh-im/delivery/messages'

/** Structural view of a Session as the tool registry hands it to a disclosure rule. */
export interface SessionLike {
  readonly actor?: unknown
}

/** Structural subset of a tool definition this gate clones. */
export interface ToolDefinitionLike {
  readonly name: string
  readonly execute: (args: unknown, exec: ToolExecutionLike) => Promise<unknown>
  readonly [key: string]: unknown
}

/** Structural subset of a tool execution used by the execution guard. */
export interface ToolExecutionLike {
  readonly agent?: { readonly session?: SessionLike }
}

/** Structural subset of the registry registration options. */
export interface RegistrationOptionsLike {
  readonly when?: (activation: { readonly agent?: { readonly session?: SessionLike } }) => boolean | Promise<boolean>
  readonly [key: string]: unknown
}

/** Structural subset of the tool registry used by this gate. */
export interface ToolRegistryLike {
  register(definition: ToolDefinitionLike, options?: RegistrationOptionsLike): () => void
  addVisibilityFilter?(filter: {
    appliesTo: (tool: ToolDefinitionLike) => boolean
    hidden: (session: SessionLike | undefined, tool: ToolDefinitionLike) => boolean
  }): () => void
}

/** Structural subset of one exact fetch route. */
interface FetchRouteLike {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** Structural subset of the connection service and its route registry. */
interface ConnectionLike {
  readonly fetch?: { register(route: FetchRouteLike): () => Promise<void> }
}

/** Options for the tool gate. */
export interface ToolGateOptions {
  /** `true` keeps dsh-im's original always-on registration (explicit opt-in). */
  readonly registerTools: boolean
  /** Workspace-level administration, read when a step is prepared. */
  readonly isAdmin: () => boolean
  /** Optional observation hook for diagnostics. */
  readonly logger?: { warn(message: string): void }
}

/**
 * Whether one Session may see and execute the IM tools.
 *
 * An IM Session acts for somebody through an opaque DataOps `actor`; its presence is the
 * host-issued authorization for that group turn, and the upstream tools still fail closed unless
 * the matching group request is live. A plain Web Session has no actor and needs an administrator
 * workspace.
 */
export function isSessionAuthorized(session: SessionLike | undefined, options: Pick<ToolGateOptions, 'registerTools' | 'isAdmin'>): boolean {
  if (options.registerTools) return true
  if (session?.actor !== undefined) return isScopeActor(session.actor)
  return options.isAdmin() === true
}

/** Read the tool registry from a Host context without depending on its type package. */
function toolRegistry(ctx: Context): ToolRegistryLike | undefined {
  return (ctx as unknown as { tools?: ToolRegistryLike }).tools
}

/** Read the connection service from a Host context without depending on its type package. */
function connectionService(ctx: Context): ConnectionLike | undefined {
  return (ctx as unknown as { connection?: ConnectionLike }).connection
}

/**
 * Shadow `connection.fetch` with a wrapping registry.
 *
 * DSH's Connection service exposes `fetch` as a prototype getter that returns a new registry
 * object on every read, so assigning `register` on the value from one read does not affect the
 * next one (and dsh-im would keep the original). Defining an own getter on the service instance
 * makes every later read — including dsh-im's — observe the wrapper.
 */
function shadowConnectionFetch(ctx: Context, wrap: (route: FetchRouteLike) => FetchRouteLike): () => void {
  const service = connectionService(ctx) as (ConnectionLike & { fetch?: ConnectionLike['fetch'] }) | undefined
  if (service === undefined) return () => {}
  const current = service.fetch
  if (current === undefined || typeof current.register !== 'function') return () => {}
  const register = current.register.bind(current)
  const wrapped: NonNullable<ConnectionLike['fetch']> = {
    register: route => register(wrap(route)),
  }
  const own = Object.getOwnPropertyDescriptor(service, 'fetch')
  Object.defineProperty(service, 'fetch', {
    configurable: true,
    enumerable: own?.enumerable ?? true,
    get: () => wrapped,
  })
  return () => {
    if (own === undefined) {
      delete (service as { fetch?: unknown }).fetch
    } else {
      Object.defineProperty(service, 'fetch', own)
    }
  }
}

/**
 * Intercept dsh-im's three tool registrations and re-register them behind a step condition.
 *
 * dsh-im registers the tools unconditionally at activation. The gate owns the public
 * `tools.register` surface only for the lifetime of the wrapper: non-IM registrations pass
 * through unchanged, while IM definitions are cloned with an execution check and registered with
 * `when`, which the base evaluates per Session before assembling the model-visible tool set.
 *
 * @param ctx - Host context carrying the tool registry.
 * @param options - registration opt-in and workspace administration lookup.
 * @returns disposer restoring the registry and disposing this gate's registrations.
 */
export function installImToolGate(ctx: Context, options: ToolGateOptions): () => void {
  const registry = toolRegistry(ctx)
  if (registry === undefined || typeof registry.register !== 'function') {
    options.logger?.warn('dataops-im: no tool registry; IM tools will not be registered')
    return () => {}
  }
  const original = registry.register
  const realRegister = original.bind(registry)
  const active = new Map<string, () => void>()

  const guard = (definition: ToolDefinitionLike): ToolDefinitionLike => {
    const execute = definition.execute.bind(definition)
    return {
      ...definition,
      execute: async (args, exec) => {
        if (!isSessionAuthorized(exec?.agent?.session, options)) {
          throw new Error('IM tools are restricted to administrators or authorized IM Sessions.')
        }
        return execute(args, exec)
      },
    }
  }

  registry.register = (definition, registrationOptions = {}) => {
    if (!IM_TOOL_NAMES.has(definition.name)) return realRegister(definition, registrationOptions)
    const guarded = guard(definition)
    if (active.has(definition.name)) return () => {}
    const upstreamWhen = registrationOptions.when
    const dispose = realRegister(guarded, {
      ...registrationOptions,
      when: async activation => {
        if (!isSessionAuthorized(activation?.agent?.session, options)) return false
        return upstreamWhen === undefined ? true : upstreamWhen(activation)
      },
    })
    active.set(definition.name, dispose)
    return () => {
      const current = active.get(definition.name)
      if (current !== undefined) {
        active.delete(definition.name)
        current()
      }
    }
  }

  let visibilityDispose: (() => void) | undefined
  if (typeof registry.addVisibilityFilter === 'function') {
    visibilityDispose = registry.addVisibilityFilter({
      appliesTo: tool => IM_TOOL_NAMES.has(tool.name),
      hidden: session => !isSessionAuthorized(session, options),
    })
  }

  return () => {
    visibilityDispose?.()
    visibilityDispose = undefined
    for (const dispose of active.values()) dispose()
    active.clear()
    registry.register = original
  }
}

/** Options for the management RPC gate. */
export interface RpcGateOptions {
  readonly resolver: ScopeResolver
  readonly logger?: { warn(message: string): void }
}

/**
 * Gate dsh-im's management HTTP/RPC routes on the current DataOps principal.
 *
 * dsh-im registers each management channel as an exact route below `/api/dsh-im/`. Wrapping the
 * route registration lets one check cover every channel without patching the pinned package.
 * Data-plane ingress keeps its own path and is never wrapped.
 *
 * @param ctx - Host context carrying the client connection.
 * @param options - scope resolver used for the decision.
 * @returns disposer restoring the route registry.
 */
export function installManagementRpcGate(ctx: Context, options: RpcGateOptions): () => void {
  if (connectionService(ctx)?.fetch === undefined) {
    options.logger?.warn('dataops-im: no connection fetch registry; IM management RPC gate is not installed')
    return () => {}
  }
  return shadowConnectionFetch(ctx, route => {
    const path = route?.path
    if (typeof path !== 'string' || !path.startsWith('/api/dsh-im/') || path === DELIVERY_INGRESS_PATH) {
      return route
    }
    const inner = route.fetch
    return {
      ...route,
      fetch: async request => {
        const token = bearerToken(request.headers)
        if (token !== undefined) {
          // A management request carries the gateway's fresh DataOps JWT. Adopt it before
          // deciding so an administrator whose session was renewed is not judged on the old one.
          await options.resolver.adopt(token).catch(() => undefined)
        }
        if (!options.resolver.isAdmin()) {
          return new Response(JSON.stringify({
            ok: false,
            error: { code: 'forbidden', message: 'IM management requires system:im:manage or an administrator role.' },
          }), { status: 403, headers: { 'content-type': 'application/json; charset=utf-8' } })
        }
        return inner(request)
      },
    }
  })
}

/** Register the small administrator-only read surface used by the admin-mode settings page. */
export interface AdminRouteOptions {
  readonly resolver: ScopeResolver
  readonly baseUrl: string
  readonly mode: 'admin' | 'connector'
  readonly logger?: { warn(message: string): void }
  /** 连接器身份桥的只读状态；admin 模式不传。 */
  readonly identityStatus?: (sessionId: string) => unknown
  /** 连接器身份桥的待绑定发送者；admin 模式不传。 */
  readonly identityPending?: () => unknown
}

/** JSON response with no-store semantics for identity and bot metadata. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Remove credential-shaped fields from a bot record before it reaches the browser. */
export function sanitizeBotRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = { ...(value as Record<string, unknown>) }
  for (const key of Object.keys(record)) {
    // `secretConfigured` is a safe boolean flag the management UI renders; a secret value is
    // never a boolean, so keep boolean flags and strip every credential-shaped value.
    if (/(secret|token|password|credential|private.?key)/i.test(key) && typeof record[key] !== 'boolean') {
      delete record[key]
    }
  }
  return record
}

/**
 * Install the administrator check and the read-only bot list.
 *
 * The check route answers 200 with `admin:false` for an ordinary user: the client needs a
 * boolean to decide whether to register anything at all. The bot route is the actual boundary
 * and answers 403 for the same caller.
 */
export function installAdminRoutes(ctx: Context, options: AdminRouteOptions): (() => Promise<void>)[] {
  const registry = connectionService(ctx)?.fetch
  if (registry === undefined || typeof registry.register !== 'function') return []
  const disposers: (() => Promise<void>)[] = []

  disposers.push(registry.register({
    path: '/api/dsh-dataops-im/auth',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async request => {
      const token = bearerToken(request.headers)
      if (token !== undefined) await options.resolver.adopt(token).catch(() => undefined)
      const scope = options.resolver.current()
      return json({
        ok: true,
        admin: options.resolver.isAdmin(),
        mode: options.mode,
        role: scope?.primaryRole ?? scope?.roleCodes?.[0] ?? null,
        permissions: scope?.permissions ?? [],
      })
    },
  }))

  const identityStatus = options.identityStatus
  if (identityStatus !== undefined) {
    disposers.push(registry.register({
      path: '/api/dsh-dataops-im/identity/status',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async request => {
        const token = bearerToken(request.headers)
        if (token !== undefined) await options.resolver.adopt(token).catch(() => undefined)
        if (!options.resolver.isAdmin()) {
          return json({ ok: false, error: { code: 'forbidden', message: 'IM management requires system:im:manage or an administrator role.' } }, 403)
        }
        const url = new URL(request.url, 'http://localhost')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId === '') {
          return json({ ok: false, error: { code: 'bad-request', message: 'sessionId is required.' } }, 400)
        }
        const status = identityStatus(sessionId)
        return json({ ok: true, status: status ?? null })
      },
    }))
  }

  const identityPending = options.identityPending
  if (identityPending !== undefined) {
    disposers.push(registry.register({
      path: '/api/dsh-dataops-im/identity/pending',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async request => {
        const token = bearerToken(request.headers)
        // 待绑定发送者只允许携带 DataOps 身份的管理员读取；没有 Bearer 的请求不能复用
        // 上一次请求缓存的 scope，否则匿名请求可能搭上刚才管理员的身份。
        if (token === undefined) {
          return json({ ok: false, error: { code: 'forbidden', message: 'IM management requires system:im:manage or an administrator role.' } }, 403)
        }
        await options.resolver.adopt(token).catch(() => undefined)
        if (!options.resolver.isAdmin()) {
          return json({ ok: false, error: { code: 'forbidden', message: 'IM management requires system:im:manage or an administrator role.' } }, 403)
        }
        // senderId 是管理员绑定的输入，返回完整值；记录本身不含 token。
        return json({ ok: true, items: identityPending() })
      },
    }))
  }

  disposers.push(registry.register({
    path: '/api/dsh-dataops-im/bots',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async request => {
      const token = bearerToken(request.headers)
      if (token !== undefined) await options.resolver.adopt(token).catch(() => undefined)
      if (!options.resolver.isAdmin()) {
        return json({ ok: false, error: { code: 'forbidden', message: 'IM management requires system:im:manage or an administrator role.' } }, 403)
      }
      try {
        const response = await fetch(`${options.baseUrl.replace(/\/+$/, '')}/api/im/bots`, {
          headers: { accept: 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
          signal: AbortSignal.timeout(8_000),
        })
        if (response.status === 404) {
          return json({ ok: true, backend: 'not-implemented', bots: [] })
        }
        if (!response.ok) return json({ ok: false, error: { code: `backend-http-${String(response.status)}`, message: 'DataOps bot list is unavailable.' } })
        const body = await response.json().catch(() => undefined) as unknown
        const list = Array.isArray(body) ? body : (body as { bots?: unknown } | undefined)?.bots
        return json({ ok: true, bots: Array.isArray(list) ? list.map(sanitizeBotRecord).filter(entry => entry !== undefined) : [] })
      } catch {
        return json({ ok: false, error: { code: 'backend-unreachable', message: 'DataOps bot list is unreachable.' } })
      }
    },
  }))

  return disposers
}