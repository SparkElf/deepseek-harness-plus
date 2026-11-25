/**
 * DataOps Task Center bridge for a managed DSH workspace.
 *
 * Approval tasks remain owned by DataOps. This plugin never stores or mutates
 * approval state; it proxies the Task Center read/action API with the workspace
 * principal and exposes the same surface to the agent as tools.
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'task-bus'
export const inject = ['webServer', 'tools', 'sessionController', 'credentials', 'attachments']

export const TASK_BUS_ROUTE = '/dsh-task-bus/api'
const TASK_CENTER_PATH = '/api/task-center'
const DATAOPS_CREDENTIAL_REF = 'DATAOPS_ACCESS_TOKEN'

type RequestLike = { url?: string; method?: string; on?: unknown }
type ResponseLike = {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Uint8Array): void
}

interface TaskBusHost {
  credentials: {
    resolve(ref: unknown): Promise<{ value?: string } | undefined>
  }
  sessionController: {
    create(request: { sessionId: string; cwd?: string }): Promise<{ sessionId: string }>
    resolveAgent(sessionId: string): Promise<{ agent?: { followup(message: unknown): void } } | { agent: { followup(message: unknown): void } }>
  }
  webServer: {
    register(options: {
      kind: 'prefix'
      path: string
      handler: (req: unknown, res: unknown) => Promise<void>
    }): () => void
  }
  tools: {
    register(tool: unknown): () => void
  }
}

const resolveBase = () => {
  const base = process.env.DATAOPS_AI_WORKSPACE_BACKEND_BASE_URL?.trim().replace(/\/+$/u, '')
  if (!base) throw new Error('DataOps Task Center is not configured in this workspace')
  return base
}


/** Make approval links usable inside the DataOps iframe, where `/tasks` is not this origin. */
const absoluteApprovalLinks = (payload: unknown): unknown => {
  const origin = process.env.DATAOPS_PUBLIC_APP_ORIGIN?.trim().replace(/\/+$/u, '')
  if (!origin || payload === null || typeof payload !== 'object') return payload
  const fix = (value: unknown) => {
    if (value === null || typeof value !== 'object') return
    const item = value as { source?: { deepLink?: unknown } }
    if (item.source !== undefined && typeof item.source.deepLink === 'string' && item.source.deepLink.startsWith('/')) {
      item.source.deepLink = origin + item.source.deepLink
    }
  }
  const record = payload as { item?: unknown; items?: unknown[] }
  fix(record.item)
  for (const item of record.items ?? []) fix(item)
  return payload
}

const createTaskCenterClient = (host: TaskBusHost) => {
  const base = resolveBase()
  return async (path: string, method: 'GET' | 'POST' = 'GET', body?: unknown) => {
    const resolved = await host.credentials.resolve(credentialRef(DATAOPS_CREDENTIAL_REF))
    const token = resolved?.value?.trim()
    if (!token) throw new Error('DataOps Task Center credential is not configured')
    const response = await fetch(base + TASK_CENTER_PATH + path, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    const payload = text ? JSON.parse(text) as unknown : null
    if (!response.ok) {
      const message = payload !== null && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : `Task Center request failed (${response.status})`
      throw new Error(message)
    }
    return payload
  }
}

const readJsonBody = async (request: RequestLike) => {
  if (request.on === undefined) return undefined
  let body = ''
  for await (const chunk of request as AsyncIterable<unknown>) {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
  }
  return body.trim() ? JSON.parse(body) as unknown : undefined
}

const writeJson = (response: ResponseLike, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

const taskListPath = (search: string) => {
  const params = new URLSearchParams(search)
  if (!params.has('status')) params.set('status', 'all')
  return '/items?' + params.toString()
}

const genericListPath = (search: string) => {
  const params = new URLSearchParams(search)
  if (!params.has('scope')) params.set('scope', 'mine')
  if (!params.has('pageSize')) params.set('pageSize', '20')
  return '/generic?' + params.toString()
}

const open = { type: 'object', additionalProperties: true } as const

/** Where this workspace stores the connector's own enabled state. */
export const CONNECTOR_STATE_PATH = join(
  process.env.DSH_HOME?.trim() || '/workspace/.dataops/dsh',
  'task-bus',
  'connector-state.json',
)

/** The persisted connector state shared by the Task Bus panel and the host tools. */
interface ConnectorState {
  enabled: boolean
  capabilities: Record<string, boolean>
}

const DEFAULT_CONNECTOR_STATE: ConnectorState = {
  enabled: false,
  capabilities: { 'approval.push': true },
}

/** Read the workspace connector state; a missing/corrupt file is a safe disabled state. */
export async function readConnectorState(path = CONNECTOR_STATE_PATH): Promise<ConnectorState> {
  try {
    const text = await readFile(path, 'utf8')
    const value = JSON.parse(text) as Partial<ConnectorState>
    return {
      enabled: value.enabled === true,
      capabilities: {
        ...DEFAULT_CONNECTOR_STATE.capabilities,
        ...(typeof value.capabilities === 'object' && value.capabilities !== null ? value.capabilities : {}),
      },
    }
  } catch {
    return { ...DEFAULT_CONNECTOR_STATE, capabilities: { ...DEFAULT_CONNECTOR_STATE.capabilities } }
  }
}

/** Persist the connector state atomically; the host and UI read the same file. */
export async function writeConnectorState(next: ConnectorState, path = CONNECTOR_STATE_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.tmp-' + process.pid.toString()
  await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8')
  await rename(temporary, path)
}

const renderJson = (_args: unknown, value: unknown) => [
  { type: 'text' as const, text: JSON.stringify(value, null, 2) },
]

const tool = (
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: (args: Record<string, unknown>) => Promise<unknown>,
) => defineTool({
  name,
  description,
  parameters: parameters as never,
  output: { schema: open, render: renderJson },
  execute: (async (args: Record<string, unknown>) => execute(args)) as never,
})

export const apply = (ctx: Context) => {
  // A bare DSH profile has no DataOps Task Center. Treat that as "feature off"
  // rather than a failed plugin: the row stays active, mounts nothing, and the
  // rest of the profile boots without an activation warning.
  if (!process.env.DATAOPS_AI_WORKSPACE_BACKEND_BASE_URL?.trim()) {
    const logger = (ctx as unknown as { logger?: { info?: (message: string) => void } }).logger
    logger?.info?.('task-bus: DataOps Task Center is not configured; the connector stays disabled')
    return
  }
  const host = ctx as unknown as TaskBusHost
  const client = createTaskCenterClient(host)

  ctx.effect(() => host.webServer.register({
    kind: 'prefix',
    path: TASK_BUS_ROUTE,
    handler: async (rawRequest, rawResponse) => {
      const request = rawRequest as RequestLike
      const response = rawResponse as ResponseLike
      const url = new URL(request.url ?? '/', 'http://dsh.internal')
      const route = url.pathname.slice(TASK_BUS_ROUTE.length).replace(/^\/+/u, '')
      try {
        if (route === 'connector') {
          if (request.method === 'GET') {
            writeJson(response, 200, await readConnectorState())
            void syncTools().catch(() => { disposeTools() })
            return
          }
          if (request.method === 'POST') {
            const body = await readJsonBody(request) as { enabled?: unknown; capabilities?: unknown } | undefined
            if (typeof body?.enabled !== 'boolean') throw new Error('connector state requires enabled:boolean')
            const current = await readConnectorState()
            const capabilities = typeof body.capabilities === 'object' && body.capabilities !== null
              ? { ...current.capabilities, ...body.capabilities as Record<string, boolean> }
              : current.capabilities
            await writeConnectorState({ enabled: body.enabled, capabilities })
            await syncTools()
            writeJson(response, 200, await readConnectorState())
            return
          }
          writeJson(response, 405, { error: 'connector state supports GET and POST' })
          return
        }
        if (request.method === 'GET' && route === 'health') {
          resolveBase()
          writeJson(response, 200, { ok: true, source: 'dataops_approval' })
          void syncTools()
          return
        }
        if (request.method === 'GET' && route === 'overview') {
          writeJson(response, 200, absoluteApprovalLinks(await client('/overview')))
          void syncTools()
          return
        }
        if (request.method === 'GET' && route === 'attachment-materialize') {
          const attachmentId = url.searchParams.get('attachmentId') ?? ''
          const name = url.searchParams.get('name') ?? 'attachment'
          const bytes = Number(url.searchParams.get('bytes') ?? '0')
          if (!attachmentId.startsWith('sha256:') || !Number.isSafeInteger(bytes) || bytes <= 0) {
            throw new Error('attachment-materialize requires a sha256 attachmentId and byte count')
          }
          const attachments = (ctx as unknown as {
            attachments?: { readFileStream(ref: unknown): AsyncIterable<Uint8Array> }
          }).attachments
          if (attachments === undefined) throw new Error('attachment store is unavailable')
          const chunks: Uint8Array[] = []
          for await (const chunk of attachments.readFileStream({ attachmentId, name, bytes })) chunks.push(chunk)
          const safeName = basename(name).replace(/[^\p{L}\p{N}._-]+/gu, '_') || 'attachment'
          const requestedCwd = url.searchParams.get('cwd')?.trim() ?? ''
          const root = requestedCwd !== '' && isAbsolute(requestedCwd) ? requestedCwd : process.cwd()
          const directory = join(root, '.dsh-attachment-preview')
          await mkdir(directory, { recursive: true })
          const relativePath = '.dsh-attachment-preview/' + attachmentId.slice('sha256:'.length, 'sha256:'.length + 12) + '-' + safeName
          await writeFile(join(root, relativePath), Buffer.concat(chunks))
          writeJson(response, 200, { path: relativePath, absolutePath: join(root, relativePath), name: safeName })
          return
        }
        if (request.method === 'GET' && route === 'count') {
          writeJson(response, 200, await client('/count'))
          return
        }
        if (request.method === 'GET' && route === 'attachment') {
          const taskId = url.searchParams.get('taskId')?.trim() ?? ''
          const attachmentId = url.searchParams.get('attachmentId')?.trim() ?? ''
          if (!/^\d+$/u.test(taskId) || !/^[0-9a-fA-F-]{36}$/u.test(attachmentId)) {
            throw new Error('attachment requires numeric taskId and UUID attachmentId')
          }
          const resolved = await host.credentials.resolve(credentialRef(DATAOPS_CREDENTIAL_REF))
          const token = resolved?.value?.trim()
          if (!token) throw new Error('DataOps Task Center credential is not configured')
          const upstream = await fetch(
            resolveBase() + '/api/tasks/' + encodeURIComponent(taskId)
              + '/attachments/' + encodeURIComponent(attachmentId) + '/download',
            { headers: { authorization: `Bearer ${token}` } },
          )
          if (!upstream.ok) {
            const text = await upstream.text()
            throw new Error(text || `Attachment download failed (${upstream.status})`)
          }
          const buffer = Buffer.from(await upstream.arrayBuffer())
          response.writeHead(upstream.status, {
            'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
            'content-disposition': upstream.headers.get('content-disposition') ?? 'attachment',
            'content-length': String(buffer.length),
            'cache-control': 'private, no-store',
          })
          response.end(buffer)
          return
        }
        if (request.method === 'GET' && route === 'items') {
          writeJson(response, 200, absoluteApprovalLinks(await client(taskListPath(url.search))))
          return
        }
        if (request.method === 'GET' && route === 'generic') {
          writeJson(response, 200, await client(genericListPath(url.search)))
          return
        }
        if (request.method === 'POST' && route === 'ai-accept') {
          const body = await readJsonBody(request) as { id?: unknown; prompt?: unknown } | undefined
          const id = typeof body?.id === 'string' ? body.id : ''
          if (!id) throw new Error('ai-accept requires a task id')
          const task = id.startsWith('approval:')
            ? await client(`/items/${encodeURIComponent(id)}`)
            : id.startsWith('task:')
              ? await client(`/generic/${encodeURIComponent(id.slice(5))}`)
              : null
          if (task === null) throw new Error('ai-accept requires an approval:<id> or task:<uuid> id')
          const card = (task as { item?: { title?: string; source?: { label?: string }; sourceType?: string } }).item
          const title = card?.title ?? id
          const sessionId = `task-bus-${crypto.randomUUID()}`
          await host.sessionController.create({
            sessionId,
            ...(process.env.DATAOPS_AI_WORKSPACE_MOUNT_PATH === undefined
              ? {}
              : { cwd: process.env.DATAOPS_AI_WORKSPACE_MOUNT_PATH }),
          })
          const resolved = await host.sessionController.resolveAgent(sessionId)
          const agent = 'agent' in resolved ? resolved.agent : undefined
          if (agent === undefined) throw new Error('无法为任务绑定 AI 会话')
          const prompt = String(body?.prompt ?? '')
            || `这是 DataOps 任务「${title}」（${id}），来源：${card?.source?.label ?? card?.sourceType ?? 'Task Center'}。请先阅读任务上下文，整理材料并给出办理建议；不要替审批人通过、驳回或提交审批。`
          agent.followup(createUserMessage({
            source: { kind: 'task-bus', taskId: id } as never,
            content: [{ type: 'text', text: prompt }],
          }))
          writeJson(response, 201, { sessionId, taskId: id })
          return
        }
        const transition = /^generic\/([^/]+)\/transition$/u.exec(route)
        if (request.method === 'POST' && transition !== null) {
          writeJson(
            response,
            200,
            await client(`/generic/${encodeURIComponent(transition[1]!)}/transition`, 'POST', await readJsonBody(request)),
          )
          return
        }
        if (request.method === 'POST' && route === 'generic') {
          writeJson(response, 201, await client('/generic', 'POST', await readJsonBody(request)))
          return
        }
        const detail = /^generic\/([^/]+)$/u.exec(route)
        if (request.method === 'GET' && detail !== null) {
          writeJson(response, 200, await client(`/generic/${encodeURIComponent(detail[1]!)}`))
          return
        }
        const approval = /^items\/([^/]+)$/u.exec(route)
        if (request.method === 'GET' && approval !== null) {
          writeJson(response, 200, absoluteApprovalLinks(await client(`/items/${encodeURIComponent(decodeURIComponent(approval[1]!))}`)))
          return
        }
        writeJson(response, 404, { error: 'Unknown Task Bus route' })
      } catch (error) {
        writeJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'task-bus: browser API')

  /**
   * Tool definitions are static; only their registration is permission-dependent.
   *
   * This is the plugin-side disclosure boundary: the model never sees a tool the
   * current DataOps principal cannot use. Authorization itself remains at the
   * DataOps Task Center API; this layer only adjusts what the connector contributes.
   */
  const toolDefinitions = [
    {
      permission: 'workflow:task:read',
      definition: tool(
        'task_center_list',
        'List DataOps Task Center cards visible to the current workspace user, including approval tasks and generic Task Bus tasks. Approval cards are read-only projections of DataOps tasks.',
        {
          status: { type: 'string', enum: ['all', 'pending', 'done'] },
          scope: { type: 'string', enum: ['mine', 'created', 'all'] },
          limit: { type: 'number' },
        },
        async (args) => {
          const status = typeof args.status === 'string' ? args.status : 'all'
          const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, args.limit)) : 20
          const result = absoluteApprovalLinks(await client('/overview')) as { items?: Array<{ status?: string }> }
          const items = (result.items ?? []).filter((item) => {
            if (status === 'pending') return item.status !== 'completed' && item.status !== 'cancelled'
            if (status === 'done') return item.status === 'completed' || item.status === 'cancelled'
            return true
          }).slice(0, limit)
          return { ...result, items, total: items.length }
        },
      ),
    },
    {
      permission: 'workflow:task:read',
      definition: tool(
        'task_center_get',
        'Read one Task Center card by its stable id. Use approval:<id> for a DataOps approval task or task:<uuid> for a generic Task Bus task.',
        { id: { type: 'string', required: true } },
        async (args) => {
          const id = String(args.id ?? '')
          if (id.startsWith('approval:')) return client(`/items/${encodeURIComponent(id)}`)
          if (id.startsWith('task:')) return client(`/generic/${encodeURIComponent(id.slice(5))}`)
          throw new Error('Task Center id must start with approval: or task:')
        },
      ),
    },
    {
      permission: 'workflow:task:create',
      definition: tool(
        'task_center_create',
        [
          'Create a generic Task Center card ONLY when the user explicitly asks you to create a task/card in this turn.',
          'Never call this tool proactively, speculatively, as a side effect of another request, or merely because work could be tracked.',
          'If the user did not explicitly ask for a new card, do not call it; ask for confirmation instead.',
          'This never creates or mutates a DataOps approval task.',
        ].join(' '),
        {
          title: { type: 'string', required: true },
          description: { type: 'string' },
          source_type: { type: 'string' },
          source_id: { type: 'string' },
          assignee_user_id: { type: 'string' },
          priority: { type: 'string' },
          user_requested: {
            type: 'boolean',
            required: true,
            description: 'Must be true only when the user explicitly requested creation of this card in the current turn.',
          },
        },
        async (args) => {
          if (args.user_requested !== true) {
            throw new Error('task_center_create requires an explicit user request; do not create Task Center cards proactively')
          }
          return client('/generic', 'POST', {
            title: String(args.title ?? ''),
            description: typeof args.description === 'string' ? args.description : undefined,
            sourceType: typeof args.source_type === 'string' ? args.source_type : 'agent',
            sourceId: typeof args.source_id === 'string' ? args.source_id : undefined,
            assigneeUserId: typeof args.assignee_user_id === 'string' ? args.assignee_user_id : undefined,
            priority: typeof args.priority === 'string' ? args.priority : undefined,
          })
        },
      ),
    },
    {
      permission: 'workflow:task:execute',
      definition: tool(
        'task_center_transition',
        'Advance a generic Task Bus task. Approval tasks must be handled through the existing DataOps approval UI and APIs; this tool refuses approval ids.',
        {
          id: { type: 'string', required: true },
          action: {
            type: 'string',
            required: true,
            enum: ['accept', 'start', 'submit', 'complete', 'cancel', 'block', 'unblock'],
          },
          comment: { type: 'string' },
        },
        async (args) => {
          const id = String(args.id ?? '')
          if (!id.startsWith('task:')) throw new Error('Only generic task:<uuid> cards can be transitioned here')
          return client(`/generic/${encodeURIComponent(id.slice(5))}/transition`, 'POST', {
            action: String(args.action ?? ''),
            comment: typeof args.comment === 'string' ? args.comment : undefined,
          })
        },
      ),
    },
  ] as const

  const toolDisposers = new Map<string, () => void>()
  let syncGeneration = 0

  const disposeTools = (): void => {
    for (const dispose of toolDisposers.values()) dispose()
    toolDisposers.clear()
  }

  /** Read the current principal's DataOps permission keys without caching them per tool call. */
  const loadPermissionKeys = async (): Promise<Set<string> | null> => {
    try {
      const resolved = await host.credentials.resolve(credentialRef(DATAOPS_CREDENTIAL_REF))
      const token = resolved?.value?.trim()
      if (!token) return null
      const response = await fetch(resolveBase() + '/api/ai/review/context', {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })
      if (!response.ok) return null
      const body = await response.json() as { permissions?: unknown; permissionKeys?: unknown }
      const values = Array.isArray(body.permissions)
        ? body.permissions
        : Array.isArray(body.permissionKeys) ? body.permissionKeys : null
      return values === null ? null : new Set(values.filter((item): item is string => typeof item === 'string'))
    } catch {
      return null
    }
  }

  /**
   * Reconcile connector state, principal permissions and the registered tool set.
   *
   * Called at plugin start, after every browser API request, and after a connector
   * enable/disable change. The tool execution path never repeats this work.
   */
  const syncTools = async (): Promise<void> => {
    const generation = ++syncGeneration
    const state = await readConnectorState()
    if (!state.enabled || state.capabilities['approval.push'] === false) {
      disposeTools()
      return
    }
    const permissions = await loadPermissionKeys()
    if (permissions === null) {
      disposeTools()
      return
    }
    if (generation !== syncGeneration) return
    for (const item of toolDefinitions) {
      const existing = toolDisposers.get(item.definition.name)
      if (permissions.has(item.permission)) {
        if (existing === undefined) {
          toolDisposers.set(item.definition.name, host.tools.register(item.definition))
        }
      } else if (existing !== undefined) {
        existing()
        toolDisposers.delete(item.definition.name)
      }
    }
  }

  ctx.effect(() => {
    void syncTools().catch(() => { disposeTools() })
    return () => {
      syncGeneration += 1
      disposeTools()
    }
  }, 'task-bus: permission-aware tool disclosure')

}
