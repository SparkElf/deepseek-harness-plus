/**
 * Host half of the credential manager: same-origin HTTP API for the Sidebar and
 * the guarded model tools. The browser never receives a secret, and the model
 * tools never receive one on the way out either.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WorkbenchVault } from '@sparkelf/dsh-workbench-vault'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CredentialError, validationError } from './errors.ts'
import { CredentialManagerStore } from './store.ts'
import { CREDENTIAL_TEMPLATES } from './templates.ts'
import { createCredentialTools } from './tools.ts'
import type { CredentialDraft, CredentialSecretInput } from './types.ts'

export * from './types.ts'
export * from './connectors.ts'
export { CREDENTIAL_TEMPLATES, defaultAuthKind, defaultConfigFor, describeEndpoint, templateFor } from './templates.ts'
export { CredentialManagerStore, validateCredentialForTest } from './store.ts'
export { createCredentialTools } from './tools.ts'
export { normalizeDraft, normalizeSecrets } from './validation.ts'

export const name = 'credential-manager'
export const inject = ['webServer', 'tools', 'approval', 'credentials']

export interface CredentialWebServer {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }): () => void
}

export interface CredentialToolsService {
  register(tool: unknown): () => void
}

export type CredentialContext = CordisContext & {
  webServer: CredentialWebServer
  tools: CredentialToolsService
}

export interface CredentialApplyOptions {
  /** Test/embedding override; production resolves `~/.dsh/credential-manager.json`. */
  dataFile?: string
  /** Test/embedding override for the shared encrypted vault directory. */
  vaultDirectory?: string
}

const MAX_BODY_BYTES = 1_048_576
const API_PREFIX = '/dsh-credential-manager/api/'

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new CredentialError('Request body is too large', { status: 413, code: 'payload_too_large' })
    chunks.push(buffer)
  }
  if (size === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw validationError('Request body must be valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw validationError('Request body must be a JSON object')
  return parsed as Record<string, unknown>
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || value.trim() === '') throw validationError(key + ' is required')
  return value
}

function readSecretInput(value: unknown): CredentialSecretInput | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw validationError('secret must be an object')
  const secret: CredentialSecretInput = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw validationError('secret.' + key + ' must be a string')
    secret[key] = item
  }
  return secret
}

/**
 * Host API methods, extracted so tests can exercise the same mapping the
 * browser uses without starting an HTTP server.
 */
export function createCredentialHostMethods(store: CredentialManagerStore): Record<string, (payload: Record<string, unknown>) => Promise<unknown>> {
  return {
    state: () => store.state(),
    templates: async () => ({ templates: CREDENTIAL_TEMPLATES }),

    'credentials.save': async payload => {
      const raw = payload.credential
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw validationError('credential must be an object')
      const draft = raw as CredentialDraft
      const secret = readSecretInput(payload.secret)
      if (typeof draft.id === 'string' && draft.id !== '') {
        return store.update(draft.id, {
          name: draft.name,
          description: draft.description,
          tags: draft.tags,
          enabled: draft.enabled,
          authKind: draft.authKind,
          config: draft.config,
          secretRef: draft.secretRef,
        }, secret)
      }
      return store.create(draft, secret)
    },

    'credentials.delete': async payload => {
      const credentialId = requireString(payload, 'credentialId')
      if (payload.confirm !== true) throw validationError('Deleting a credential requires confirm=true')
      const confirmName = requireString(payload, 'confirmName')
      return store.delete(credentialId, { confirmed: true, name: confirmName })
    },

    'credentials.toggle': async payload => {
      const credentialId = requireString(payload, 'credentialId')
      if (typeof payload.enabled !== 'boolean') throw validationError('enabled must be a boolean')
      return store.setEnabled(credentialId, payload.enabled)
    },

    'credentials.test': async payload => {
      const credentialId = requireString(payload, 'credentialId')
      return store.test(credentialId)
    },
  }
}

/** The same-origin HTTP handler; extracted so tests can mount it on a real server. */
export function createCredentialApiHandler(
  store: CredentialManagerStore,
  logger: { error(...args: unknown[]): void } = { error() {} },
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const methods = createCredentialHostMethods(store)
  return async (req, res) => {
    const method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice(API_PREFIX.length)
    try {
      const handler = methods[method]
      if (handler === undefined) throw new CredentialError('Unknown credential manager API method: ' + method, { status: 404, code: 'unknown_method' })
      writeJson(res, 200, await handler(await readBody(req)))
    } catch (error) {
      const status = error instanceof CredentialError ? error.status : 500
      if (status >= 500) logger.error('[dsh-credential-manager] API request failed', error)
      writeJson(res, status, {
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof CredentialError ? error.code : 'internal_error',
      })
    }
  }
}

/** Register the Sidebar API, the approval-gated model tools, and the audit trail. */
export function apply(ctx: CredentialContext, options: CredentialApplyOptions = {}): void {
  const logger = (ctx.logger ?? { info() {}, error() {} }) as unknown as { info(...args: unknown[]): void; error(...args: unknown[]): void }
  const store = new CredentialManagerStore({
    dataFile: options.dataFile,
    // Secrets go to the shared AES-256-GCM vault; ctx.credentials resolves
    // `secret_ref` names and never stores a value created by this plugin.
    vault: new WorkbenchVault(options.vaultDirectory === undefined ? {} : { directory: options.vaultDirectory }),
    describeReference: async reference => {
      const info = await ctx.credentials.describe(credentialRef(reference))
      return { configured: info.configured }
    },
    audit: event => {
      try { logger.info('[audit] dsh-credential-manager ' + JSON.stringify(event)) } catch { /* audit must not break the operation */ }
    },
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-credential-manager/api',
    handler: createCredentialApiHandler(store, logger),
  }), 'dsh-credential-manager: HTTP API')

  const approve = async ({ toolName, exec, reason }: { toolName: string; exec: { agent?: unknown; callId: string; signal: AbortSignal }; reason: string }): Promise<void> => {
    if (exec.agent === undefined) throw new Error(toolName + ' requires an initiating agent')
    const outcome = await ctx.approval.request({
      agent: exec.agent as never,
      toolName,
      callId: exec.callId as never,
      signal: exec.signal,
      reason,
    })
    if (outcome !== 'allowed-once') throw new Error(toolName + ' approval was ' + outcome)
  }

  const tools: ToolDefinition[] = createCredentialTools({ store, approve })
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), 'dsh-credential-manager: ' + tool.name)
  }
}