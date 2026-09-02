/** Controlled-restart recovery endpoint for the out-of-process Plus Supervisor. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'plus-supervisor-recovery'
export const inject = ['sessionController', 'webServer']

const SUPERVISOR_RECOVERY_PATH = '/api/plus-supervisor/recovery'
const SUPERVISOR_RECOVERY_PROMPT = 'Supervisor 在此会话执行期间重启了 DSH。请以持久化会话记录、当前工作区和工具结果为准，先确认已完成的操作，避免重复执行；继续完成剩余任务。若原任务已经全部完成，回复“已完成”。'

async function readRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * 注册一次受控restart前后使用的process-lifecycle handoff；恢复消息始终走Session Controller。
 *
 * @param ctx - Session Controller and WebServer owners from the Plus Host.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SUPERVISOR_RECOVERY_PATH,
    handler: async (request, response) => {
      try {
        const input = await readRequest(request)
        if (input.operation === 'capture') {
          const listed = await ctx.sessionController.list({}, new AbortController().signal)
          const sessionIds = listed.items
            .filter(item => item.running && item.origin !== 'subagent')
            .map(item => item.sessionId)
          json(response, 200, { sessionIds })
          return
        }

        const sessionIds = input.sessionIds as SessionId[]
        const recovered: SessionId[] = []
        const failed: { sessionId: SessionId; message: string }[] = []
        for (const sessionId of sessionIds) {
          try {
            await ctx.sessionController.prompt({
              requestId: randomUUID() as SessionRequestId,
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: SUPERVISOR_RECOVERY_PROMPT }],
            }, new AbortController().signal)
            recovered.push(sessionId)
          } catch (error) {
            ctx.logger.error('plus-supervisor-recovery: failed to recover Session "' + sessionId + '"')
            ctx.logger.error(error)
            failed.push({
              sessionId,
              message: error instanceof Error ? error.message : String(error),
            })
          }
        }
        json(response, 200, { recovered, failed })
      } catch (error) {
        ctx.logger.error('plus-supervisor-recovery: request failed')
        ctx.logger.error(error)
        json(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'plus-supervisor-recovery.route')
}
