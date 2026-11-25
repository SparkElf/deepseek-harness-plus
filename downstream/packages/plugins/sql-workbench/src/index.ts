import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { SqlContext } from './context.ts'
import { SqlWorkbenchRuntime } from './runtime.ts'
import { registerSqlTools } from './tools.ts'
import type { CatalogObject, ConnectionConfig, ObjectPreviewRequest } from './types.ts'

export const name = 'dsh-sql-workbench'
export const inject = ['webServer', 'tools', 'approval', 'credentials']

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function loggerOf(ctx: SqlContext): { error(...args: unknown[]): void } {
  return ctx.logger as unknown as { error(...args: unknown[]): void }
}

/** 创建浏览器 API 方法表，所有 UI 动作都复用 SqlWorkbenchRuntime 的领域操作。 */
function apiOf(runtime: SqlWorkbenchRuntime): Record<string, (payload: Record<string, unknown>) => Promise<unknown>> {
  return {
    state: payload => runtime.state(String(payload.sessionId)),
    'connections.save': async payload => {
      const sessionId = String(payload.sessionId)
      await runtime.saveConnection(sessionId, payload.connection as ConnectionConfig)
      return runtime.state(sessionId)
    },
    'connections.delete': async payload => {
      const sessionId = String(payload.sessionId)
      await runtime.deleteConnection(sessionId, String(payload.connectionId))
      return runtime.state(sessionId)
    },
    'connections.test': payload => runtime.test(payload.connection as ConnectionConfig),
    'catalog.list': payload => runtime.catalog(String(payload.connectionId)),
    'draft.create': async payload => {
      const sessionId = String(payload.sessionId)
      await runtime.createDraft(sessionId, String(payload.connectionId), String(payload.name), String(payload.sql))
      return runtime.state(sessionId)
    },
    'draft.update': async payload => {
      const sessionId = String(payload.sessionId)
      await runtime.updateDraft(
        sessionId,
        String(payload.draftId),
        String(payload.sql),
        payload.name === undefined ? undefined : String(payload.name),
      )
      return runtime.state(sessionId)
    },
    'draft.current': async payload => {
      const sessionId = String(payload.sessionId)
      await runtime.setCurrent(sessionId, String(payload.draftId))
      return runtime.state(sessionId)
    },
    'draft.delete': async payload => {
      const sessionId = String(payload.sessionId)
      await runtime.deleteDraft(sessionId, String(payload.draftId))
      return runtime.state(sessionId)
    },
    'draft.save': async payload => {
      const sessionId = String(payload.sessionId)
      await runtime.updateDraft(sessionId, String(payload.draftId), String(payload.sql))
      await runtime.setCurrent(sessionId, String(payload.draftId))
      await runtime.saveCurrent(sessionId, String(payload.name))
      return runtime.state(sessionId)
    },
    'saved.open': async payload => {
      const sessionId = String(payload.sessionId)
      await runtime.openSaved(sessionId, String(payload.savedQueryId))
      return runtime.state(sessionId)
    },
    'saved.delete': async payload => {
      const sessionId = String(payload.sessionId)
      await runtime.deleteSaved(sessionId, String(payload.savedQueryId))
      return runtime.state(sessionId)
    },
    'query.run': async payload => {
      const sessionId = String(payload.sessionId)
      await runtime.updateDraft(sessionId, String(payload.draftId), String(payload.sql))
      await runtime.run(sessionId, String(payload.connectionId), String(payload.sql))
      return runtime.state(sessionId)
    },
    'object.details': async payload => {
      const sessionId = String(payload.sessionId)
      await runtime.objectDetails(sessionId, String(payload.connectionId), payload.object as CatalogObject)
      return runtime.state(sessionId)
    },
    'object.preview': async payload => {
      const sessionId = String(payload.sessionId)
      const request = payload.request === undefined
        ? { object: payload.object as CatalogObject, page: 1, pageSize: 100, filters: [], sort: null }
        : payload.request as ObjectPreviewRequest
      await runtime.preview(sessionId, String(payload.connectionId), request)
      return runtime.state(sessionId)
    },
  }
}

/** 挂载 SQL HTTP、WebSocket 与模型工具，三条入口共享同一个运行时状态。 */
export function apply(ctx: SqlContext): void {
  const runtime = new SqlWorkbenchRuntime()
  const api = apiOf(runtime)
  const logger = loggerOf(ctx)
  const sockets = new Map<string, Set<WebSocket>>()
  const wss = new WebSocketServer({ noServer: true })

  const sendState = async (sessionId: string, socket: WebSocket): Promise<void> => {
    socket.send(JSON.stringify({ type: 'state', value: await runtime.state(sessionId) }))
  }

  const broadcast = async (sessionId: string): Promise<void> => {
    const sessionSockets = sockets.get(sessionId)
    if (sessionSockets === undefined) return
    const message = JSON.stringify({ type: 'state', value: await runtime.state(sessionId) })
    for (const socket of sessionSockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message)
    }
  }

  ctx.effect(() => registerSqlTools(ctx, runtime), 'dsh-sql-workbench: AI tools')
  ctx.effect(() => runtime.subscribe(sessionId => {
    void broadcast(sessionId).catch(error => {
      logger.error('[dsh-sql-workbench] state broadcast failed', error)
    })
  }), 'dsh-sql-workbench: state broadcast')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-sql-workbench/api',
    handler: async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.slice('/dsh-sql-workbench/api/'.length)
      try {
        const handler = api[method]
        if (handler === undefined) throw new Error('Unknown SQL workbench API method: ' + method)
        writeJson(res, 200, await handler(await readBody(req)))
      } catch (error) {
        logger.error('[dsh-sql-workbench] API request failed', error)
        writeJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
      }
    },
  }), 'dsh-sql-workbench: HTTP API')

  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/dsh-sql-workbench/ws',
    handler: (req: IncomingMessage, socket: Duplex, head: Uint8Array) => {
      wss.handleUpgrade(req, socket, Buffer.from(head), client => {
        const sessionId = new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('sessionId') as string
        let sessionSockets = sockets.get(sessionId)
        if (sessionSockets === undefined) {
          sessionSockets = new Set()
          sockets.set(sessionId, sessionSockets)
        }
        sessionSockets.add(client)
        void sendState(sessionId, client).catch(error => {
          logger.error('[dsh-sql-workbench] initial WebSocket state failed', error)
        })
        client.on('close', () => {
          sessionSockets?.delete(client)
          if (sessionSockets?.size === 0) sockets.delete(sessionId)
        })
      })
    },
  }), 'dsh-sql-workbench: WebSocket')

  ctx.effect(() => () => {
    for (const sessionSockets of sockets.values()) {
      for (const socket of sessionSockets) socket.close()
    }
    wss.close()
  }, 'dsh-sql-workbench: WebSocket cleanup')
}

export type {
  CatalogColumn,
  CatalogDatabase,
  CatalogObject,
  CatalogSchema,
  CatalogSnapshot,
  ConnectionConfig,
  ConnectionKind,
  QueryDraft,
  QueryResult,
  SavedQuery,
  WorkbenchState,
} from './types.ts'
