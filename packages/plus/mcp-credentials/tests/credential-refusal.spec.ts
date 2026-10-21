/**
 * The credential-refusal path of the connection supervisor, driven by a mocked
 * MCP client that refuses the credential on a reconnect.
 *
 * The behaviour under test cannot be produced in the running workspace: the
 * client connects while the page load pushes a fresh token, so there is no
 * moment at which a connection starts with an already-rejected credential.
 * Mocking the SDK is the only way to hold that input still.
 *
 * What must hold: a 401/403 keeps the registered tools and retries on the
 * minutes-long credential curve, instead of spending the outage budget and
 * unregistering every tool until the plugin or Host is restarted.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Config } from '../src/index.ts'

const { mockConnect, mockClose, mockListTools, MockClient, instances } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  class MockClient {
    onclose: (() => void) | undefined
    connect = mockConnect
    close = mockClose
    request = async (request: { method: string }): Promise<unknown> => {
      if (request.method === 'tools/list') return await mockListTools()
      throw new Error(`unexpected MCP request: ${request.method}`)
    }

    setNotificationHandler = vi.fn()

    constructor() {
      instances.push(this)
    }
  }
  const instances: MockClient[] = []
  return { mockConnect, mockClose, mockListTools, MockClient, instances }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: MockClient }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }))

import { resolveReconnectPolicy, startConnection } from '../src/connection.ts'

/** A connection refusal shaped the way the SDK reports an HTTP status. */
function refusal(status: number): Error & { code: number } {
  return Object.assign(new Error(`request failed with status ${status}`), { code: status })
}

function config(): Config {
  return {
    transport: 'streamable-http',
    serverName: 'dataops',
    url: 'http://127.0.0.1:9/mcp',
    headers: {},
    toolCallTimeoutMs: 5_000,
    failOnStartupError: false,
  } as Config
}

function listing(...names: string[]): unknown {
  return { tools: names.map(name => ({ name, inputSchema: { type: 'object' } })), nextCursor: undefined }
}

/** Poll until the predicate holds, so the test never depends on an exact timer count. */
async function until(predicate: () => boolean, label: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('credential refusal keeps the tool generation', () => {
  let ctx: Context
  let warnings: string[]
  let errors: string[]

  beforeEach(async () => {
    vi.clearAllMocks()
    instances.length = 0
    warnings = []
    errors = []
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
    ctx.logger.info = (() => {}) as typeof ctx.logger.info
  })

  it('retries a 401 on the credential curve and never unregisters the tools', async () => {
    mockConnect.mockResolvedValueOnce(undefined)
    mockListTools.mockResolvedValue(listing('query'))
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })

    const policy = resolveReconnectPolicy(
      { initialDelayMs: 20, maxDelayMs: 40, maxAttempts: 3 },
      'mcp-client(dataops)',
    )
    const handle = startConnection(ctx, config(), policy)

    await until(() => ctx.tools.get('mcp__dataops__query') !== undefined, 'the initial tool registration')

    // Every later attempt is refused the way an expired token is refused.
    mockConnect.mockRejectedValue(refusal(401))

    // A transport close starts the outage path; the next attempt meets the 401.
    instances[0]?.onclose?.()

    await until(() => warnings.some(line => line.includes('credential rejected by the server')), 'the credential warning')

    // Well past maxAttempts on the outage curve: the credential path must not give up.
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(errors.some(line => line.includes('giving up after'))).toBe(false)
    expect(ctx.tools.get('mcp__dataops__query')).toBeDefined()

    handle.dispose()
  })

  it('still gives up on a non-credential failure after the attempt budget', async () => {
    mockConnect.mockResolvedValueOnce(undefined)
    mockListTools.mockResolvedValue(listing('query'))
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })

    const policy = resolveReconnectPolicy(
      { initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 2 },
      'mcp-client(dataops)',
    )
    const handle = startConnection(ctx, config(), policy)

    await until(() => ctx.tools.get('mcp__dataops__query') !== undefined, 'the initial tool registration')
    mockConnect.mockRejectedValue(new Error('ECONNREFUSED'))

    instances[0]?.onclose?.()

    await until(() => errors.some(line => line.includes('giving up after')), 'the give-up error')
    expect(warnings.some(line => line.includes('credential rejected by the server'))).toBe(false)

    handle.dispose()
  })
})
