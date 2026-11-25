import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
export interface SshWebServer {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }): () => void
  registerUpgrade(route: { path: string; handler(req: IncomingMessage, socket: Duplex, head: Uint8Array): void | Promise<void> }): () => void
}
export interface SshToolsService { register(tool: unknown): () => void }
export type SshContext = CordisContext & { webServer: SshWebServer; tools: SshToolsService }
