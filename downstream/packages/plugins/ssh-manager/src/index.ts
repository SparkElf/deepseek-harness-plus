import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-credentials'
import { WorkbenchVault } from '@sparkelf/dsh-workbench-vault'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { SshContext } from './context.ts'
import { SshManagerStore } from './store.ts'
import { SshPortForwardManager } from './forward.ts'
import { downloadSftpFile, listSftpFiles, uploadSftpFile } from './sftp.ts'
import { SshTerminalManager } from './terminal.ts'
import { executeSshCommand, probeSshHostKey, testSshDraft, testSshHost } from './transport.ts'
import type { SshAuthKind, SshCluster, SshCommandRequest, SshCredentialInput, SshEnvironment, SshHost, SshPortForwardRequest } from './types.ts'

export * from './types.ts'
export { SshPortForwardManager } from './forward.ts'
export { downloadSftpFile, listSftpFiles, uploadSftpFile } from './sftp.ts'
export { SshManagerStore, sshCredentialKey, type SshCredentialRecords } from './store.ts'
export { SshTerminalManager } from './terminal.ts'
export { executeSshCommand, fingerprintFromHash, probeSshHostKey, sshConnectConfig, testSshDraft, testSshHost } from './transport.ts'
export const name = 'ssh-manager'
export const inject = ['webServer', 'tools', 'approval', 'credentials']

type ToolJson = null | boolean | number | string | ToolJson[] | { [key: string]: ToolJson }
function toolJson<T>(value: T): Record<string, ToolJson> { return value as unknown as Record<string, ToolJson> }

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

function publicHost(host: SshHost): Record<string, ToolJson> {
  const { credentialId: _credentialId, ...metadata } = host
  return metadata as unknown as Record<string, ToolJson>
}

/** Register persistent host inventory APIs and sanitized model tools. */
export function apply(ctx: SshContext): void {
  const store = new SshManagerStore({ credentials: ctx.credentials, legacyVault: new WorkbenchVault() })
  const terminals = new SshTerminalManager(store)
  const forwards = new SshPortForwardManager(store)
  const terminalWss = new WebSocketServer({ noServer: true })
  const logger = ctx.logger as unknown as { error(...args: unknown[]): void }
  const methods: Record<string, (payload: Record<string, unknown>) => Promise<unknown>> = {
    state: () => store.state(),
    'clusters.save': async payload => { await store.saveCluster(payload.cluster as SshCluster); return store.state() },
    'clusters.delete': async payload => { await store.deleteCluster(String(payload.clusterId)); return store.state() },
    'hosts.save': async payload => { await store.saveHost(payload.host as SshHost, payload.credential as SshCredentialInput | undefined); return store.state() },
    'hosts.delete': async payload => { await store.deleteHost(String(payload.hostId)); return store.state() },
    'hosts.get': async payload => publicHost(await store.host(String(payload.hostId))),
    'hosts.test': async payload => testSshHost(store, String(payload.hostId)),
    'hosts.testDraft': async payload => {
      const host = payload.host as SshHost
      let credential = payload.credential as SshCredentialInput | undefined
      // An edited host may test without retyping its secret; the stored grant is the same
      // credential the save path would keep.
      if (host.id !== '' && (credential === undefined || Object.values(credential).every(value => value === undefined || value === ''))) {
        try { credential = await store.credential(host.id) } catch { /* the host may not exist yet */ }
      }
      return testSshDraft(host, credential)
    },
    'hosts.probe': async payload => ({ fingerprint: await probeSshHostKey(payload.host as SshHost) }),
    'hosts.execute': async payload => executeSshCommand(store, String(payload.hostId), String(payload.command), payload.timeoutMs === undefined ? undefined : Number(payload.timeoutMs)),
    'sftp.list': async payload => listSftpFiles(store, String(payload.hostId), String(payload.path ?? '.')),
    'sftp.download': async payload => downloadSftpFile(store, String(payload.hostId), String(payload.path)),
    'sftp.upload': async payload => uploadSftpFile(store, String(payload.hostId), String(payload.path), String(payload.data)),
    'terminals.open': async payload => { const sessionId = String(payload.sessionId); const terminal = await terminals.open(sessionId, String(payload.hostId), Number(payload.cols ?? 80), Number(payload.rows ?? 24)); return { terminal, terminals: terminals.list(sessionId) } },
    'terminals.list': async payload => terminals.list(String(payload.sessionId)),
    'terminals.reconnect': async payload => { const sessionId = String(payload.sessionId); const terminal = await terminals.reconnect(sessionId, String(payload.terminalId), Number(payload.cols ?? 80), Number(payload.rows ?? 24)); return { terminal, terminals: terminals.list(sessionId) } },
    'terminals.close': async payload => { const sessionId = String(payload.sessionId); terminals.close(sessionId, String(payload.terminalId)); return terminals.list(sessionId) },
    'forwards.open': async payload => { const sessionId = String(payload.sessionId); const forward = await forwards.open(sessionId, payload.forward as SshPortForwardRequest); return { forward, forwards: forwards.list(sessionId) } },
    'forwards.list': async payload => forwards.list(String(payload.sessionId)),
    'forwards.reconnect': async payload => { const sessionId = String(payload.sessionId); const forward = await forwards.reconnect(sessionId, String(payload.forwardId)); return { forward, forwards: forwards.list(sessionId) } },
    'forwards.close': async payload => { const sessionId = String(payload.sessionId); forwards.close(sessionId, String(payload.forwardId)); return forwards.list(sessionId) },
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-ssh-manager/api', handler: async (req, res) => {
    const method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice('/dsh-ssh-manager/api/'.length)
    try {
      const handler = methods[method]
      if (handler === undefined) throw new Error('Unknown SSH Manager API method: ' + method)
      writeJson(res, 200, await handler(await readBody(req)))
    } catch (error) {
      logger.error('[dsh-ssh-manager] API request failed', error)
      writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  } }), 'dsh-ssh-manager: HTTP API')

  ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/dsh-ssh-manager/terminal', handler: (req: IncomingMessage, socket: Duplex, head: Uint8Array) => {
    terminalWss.handleUpgrade(req, socket, Buffer.from(head), client => {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const sessionId = url.searchParams.get('sessionId')
      const terminalId = url.searchParams.get('terminalId')
      if (sessionId === null || terminalId === null) { client.close(1008, 'sessionId and terminalId are required'); return }
      let detach: (() => void) | undefined
      try { detach = terminals.attach(sessionId, terminalId, event => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event)) }) }
      catch (error) { client.close(1008, error instanceof Error ? error.message : String(error)); return }
      client.on('message', raw => {
        try {
          const message = JSON.parse(raw.toString()) as { type?: string; data?: string; cols?: number; rows?: number }
          if (message.type === 'input') terminals.write(sessionId, terminalId, String(message.data ?? ''))
          else if (message.type === 'resize') terminals.resize(sessionId, terminalId, Number(message.cols), Number(message.rows))
          else if (message.type === 'close') terminals.close(sessionId, terminalId)
          else throw new Error('Unknown SSH terminal message type')
        } catch (error) { client.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) })) }
      })
      client.once('close', () => { detach?.() })
    })
  } }), 'dsh-ssh-manager: terminal WebSocket')
  ctx.effect(() => () => { terminals.closeAll(); forwards.closeAll(); terminalWss.close() }, 'dsh-ssh-manager: connection cleanup')

  const open = { type: 'object', additionalProperties: true } as const
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'ssh_save_cluster', description: 'Create or update an SSH cluster using non-secret inventory metadata.', parameters: { cluster_id: { type: 'string' }, name: { type: 'string', required: true }, description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async (args: { cluster_id?: string; name: string; description?: string; tags?: string[] }) => { const state = await store.state(); const existing = state.clusters.find(cluster => cluster.id === args.cluster_id); return toolJson(await store.saveCluster({ id: existing?.id ?? '', name: args.name, description: args.description ?? existing?.description ?? '', tags: args.tags ?? existing?.tags ?? [], hostIds: existing?.hostIds ?? [] })) } })), 'dsh-ssh-manager: save cluster tool')
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'ssh_save_host', description: 'Create or update SSH host metadata without accepting credentials. Configure its credential through the SSH or DSH Credentials UI.', parameters: { host_id: { type: 'string' }, name: { type: 'string', required: true }, hostname: { type: 'string', required: true }, port: { type: 'number' }, username: { type: 'string', required: true }, environment: { type: 'string' }, auth_kind: { type: 'string' }, description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, cluster_id: { type: 'string' }, jump_host_id: { type: 'string' }, known_host_fingerprint: { type: 'string' }, keep_alive_seconds: { type: 'number' } }, output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async (args: { host_id?: string; name: string; hostname: string; port?: number; username: string; environment?: string; auth_kind?: string; description?: string; tags?: string[]; cluster_id?: string; jump_host_id?: string; known_host_fingerprint?: string; keep_alive_seconds?: number }) => { const existing = args.host_id === undefined ? undefined : await store.host(args.host_id); const environment = (args.environment ?? existing?.environment ?? 'other') as SshEnvironment; if (!['development','testing','staging','production','other'].includes(environment)) throw new Error('Invalid SSH environment'); const authKind = (args.auth_kind ?? existing?.authKind ?? 'private-key') as SshAuthKind; if (!['password','private-key','agent'].includes(authKind)) throw new Error('Invalid SSH auth kind'); const host = await store.saveHost({ id: existing?.id ?? '', name: args.name, description: args.description ?? existing?.description ?? '', tags: args.tags ?? existing?.tags ?? [], clusterId: args.cluster_id ?? existing?.clusterId ?? null, environment, hostname: args.hostname, port: args.port ?? existing?.port ?? 22, username: args.username, authKind, credentialId: existing?.credentialId ?? null, credentialConfigured: existing?.credentialConfigured ?? false, jumpHostId: args.jump_host_id ?? existing?.jumpHostId ?? null, knownHostFingerprint: args.known_host_fingerprint ?? existing?.knownHostFingerprint ?? null, keepAliveSeconds: args.keep_alive_seconds ?? existing?.keepAliveSeconds ?? 30 }); return publicHost(host) } })), 'dsh-ssh-manager: save host tool')
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'ssh_test_connection', description: 'Test TCP/SSH connectivity for one configured SSH host by id. The Host resolves the stored credential and returns latency and host-key fingerprint; no password, private key, or passphrase is returned.', parameters: { host_id: { type: 'string', required: true, description: 'Host id from ssh_list_hosts.' } }, output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async (args: { host_id: string }) => { const result = await testSshHost(store, args.host_id); return toolJson({ ok: true, hostId: result.hostId, latencyMs: result.latencyMs, fingerprint: result.fingerprint }) } })), 'dsh-ssh-manager: test connection tool')
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'ssh_delete_host', description: 'Delete one SSH host inventory entry and its referenced central credential record.', parameters: { host_id: { type: 'string', required: true } }, output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async (args: { host_id: string }) => { await store.deleteHost(args.host_id); return toolJson({ deleted: args.host_id }) } })), 'dsh-ssh-manager: delete host tool')
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'ssh_list_hosts', description: 'List configured SSH hosts and clusters. Returns non-secret metadata only.', parameters: {}, output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async () => { const state = await store.state(); return toolJson({ clusters: state.clusters, hosts: state.hosts.map(publicHost) }) } })), 'dsh-ssh-manager: list hosts tool')
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'ssh_get_host', description: 'Read one SSH host by id. Credentials are never returned.', parameters: { host_id: { type: 'string', required: true } }, output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async (args: { host_id: string }) => publicHost(await store.host(args.host_id)) })), 'dsh-ssh-manager: get host tool')
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'ssh_execute_command', description: 'Execute one command on one configured SSH host after explicit user approval. Credentials remain Host-only.', parameters: { host_id: { type: 'string', required: true }, command: { type: 'string', required: true }, timeout_ms: { type: 'number' } }, output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async (args: { host_id: string; command: string; timeout_ms?: number }, exec: ToolRunContext) => { if (exec.agent === undefined) throw new Error('ssh_execute_command requires an initiating agent'); const host = await store.host(args.host_id); const outcome = await ctx.approval.request({ agent: exec.agent, toolName: 'ssh_execute_command', callId: exec.callId, signal: exec.signal, reason: 'Run a remote command on ' + host.name + ' (' + host.username + '@' + host.hostname + ':' + host.port.toString() + ')' }); if (outcome !== 'allowed-once') throw new Error('SSH command approval was ' + outcome); return toolJson(await executeSshCommand(store, host.id, args.command, args.timeout_ms, exec.signal)) } })), 'dsh-ssh-manager: approved execute tool')
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'ssh_prepare_command', description: 'Prepare but do not execute a guarded SSH command request for explicit user review.', parameters: { host_ids: { type: 'array', items: { type: 'string' }, required: true }, command: { type: 'string', required: true }, timeout_ms: { type: 'number' } }, output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async (args: { host_ids: string[]; command: string; timeout_ms?: number }) => { for (const id of args.host_ids) await store.host(id); const request: SshCommandRequest = { hostIds: args.host_ids, command: args.command, timeoutMs: args.timeout_ms ?? 60_000, confirmation: 'always' }; return toolJson({ request, executable: false, reason: 'Explicit user approval is required before remote execution.' }) } })), 'dsh-ssh-manager: prepare command tool')
}
