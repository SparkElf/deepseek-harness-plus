import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context as CordisContext } from '@deepseek-ai/cordis'

export interface SqlWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

export interface SqlWebUpgradeRoute {
  path: string
  handler(req: IncomingMessage, socket: Duplex, head: Uint8Array): void | Promise<void>
}

export interface SqlWebServer {
  register(route: SqlWebRoute): () => void
  registerUpgrade(route: SqlWebUpgradeRoute): () => void
}

export interface SqlToolsService {
  register(tool: unknown): () => void
}

export interface SqlApproval {
  request(input: {
    agent: unknown
    toolName: string
    callId: string
    signal: AbortSignal
    reason: string
  }): Promise<string>
}

export interface SqlCredentials {
  resolve(ref: unknown): Promise<{ value?: string } | undefined>
}

export type SqlContext = CordisContext & {
  webServer: SqlWebServer
  tools: SqlToolsService
  approval: SqlApproval
  credentials: SqlCredentials
  logger: { info(...args: unknown[]): void; error(...args: unknown[]): void }
}
