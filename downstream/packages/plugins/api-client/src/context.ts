import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
export interface ApiWebServer { register(route: { kind: 'exact' | 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }): () => void }
export interface ApiToolsService { register(tool: unknown): () => void }
export interface ApiApproval {
  request(input: { agent: unknown; toolName: string; callId: string; signal: AbortSignal; reason: string }): Promise<string>
}
export interface ApiCredentials {
  resolve(ref: unknown): Promise<{ value?: string } | undefined>
}
export type ApiContext = CordisContext & {
  webServer: ApiWebServer
  tools: ApiToolsService
  approval: ApiApproval
  credentials: ApiCredentials
  logger: { info(...args: unknown[]): void; error(...args: unknown[]): void }
}
