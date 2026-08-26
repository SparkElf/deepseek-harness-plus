import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CredentialProvider, { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'

const { httpOptions } = vi.hoisted(() => ({
  httpOptions: [] as Array<Record<string, unknown> | undefined>,
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(function MockStreamableHTTPClientTransport(
    _url: URL,
    options?: Record<string, unknown>,
  ) {
    httpOptions.push(options)
  }),
}))

import { apply, Config as ConfigSchema } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import type { Config, StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { createTransport } from '@deepseek-ai/dsh-mcp-client/src/transport.ts'

class TestCredentials extends CredentialProvider {
  private value = 'token-one'

  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(this.value.length ? { value: this.value, source: 'test' } : undefined)
  }

  override describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.value.length > 0, source: 'test', writable: true })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    this.value = value
    this.notifyUpdated(ref)
    return Promise.resolve()
  }

  override unset(ref: CredentialRef): Promise<void> {
    this.value = ''
    this.notifyUpdated(ref)
    return Promise.resolve()
  }
}

const httpConfig = (overrides: Partial<StreamableHttpConfig> = {}): Config => ({
  transport: 'streamable-http',
  serverName: 'dataops',
  url: 'https://dataops.example/mcp',
  headers: {},
  bearerTokenRef: 'DATAOPS_MCP_TOKEN',
  toolCallTimeoutMs: 60_000,
  failOnStartupError: false,
  ...overrides,
})

describe('credential-backed Streamable HTTP auth', () => {
  it('accepts a bearer credential reference in config', () => {
    const resolved = ConfigSchema({
      transport: 'streamable-http',
      serverName: 'dataops',
      url: 'https://dataops.example/mcp',
      bearerTokenRef: 'DATAOPS_MCP_TOKEN',
    } as never) as StreamableHttpConfig
    expect(resolved.bearerTokenRef).toBe('DATAOPS_MCP_TOKEN')
  })

  it('fails load when bearer auth has no credential service', async () => {
    await expect(apply(new Context(), httpConfig())).rejects.toThrow(/requires the credentials service/)
  })

  it('rejects two owners for the Authorization header', async () => {
    await expect(apply(new Context(), httpConfig({
      headers: { Authorization: 'Bearer literal' },
    }))).rejects.toThrow(/cannot be configured together/)
  })

  it('resolves the current credential before every HTTP request', async () => {
    httpOptions.length = 0
    const ctx = new Context()
    await ctx.plugin(TestCredentials)
    const originalFetch = globalThis.fetch
    const seenHeaders: Headers[] = []
    globalThis.fetch = vi.fn(async (_input, init) => {
      seenHeaders.push(new Headers(init?.headers))
      return new Response(null, { status: 200 })
    }) as typeof globalThis.fetch

    try {
      createTransport(httpConfig(), ctx)
      const options = httpOptions.at(-1) as {
        fetch?: typeof globalThis.fetch
        requestInit?: { headers?: Record<string, string> }
      }
      expect(options.requestInit?.headers).toEqual({})
      expect(options.fetch).toBeDefined()

      await options.fetch?.('https://dataops.example/mcp', { headers: { 'X-Test': 'one' } })
      expect(seenHeaders.at(-1)?.get('authorization')).toBe('Bearer token-one')
      expect(seenHeaders.at(-1)?.get('x-test')).toBe('one')

      await ctx.credentials.set(credentialRef('DATAOPS_MCP_TOKEN'), 'token-two')
      await options.fetch?.('https://dataops.example/mcp', { headers: { 'X-Test': 'two' } })
      expect(seenHeaders.at(-1)?.get('authorization')).toBe('Bearer token-two')
      expect(seenHeaders.at(-1)?.get('x-test')).toBe('two')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
