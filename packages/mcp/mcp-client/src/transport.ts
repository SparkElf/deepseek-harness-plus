/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL.
 *
 * @module
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './index.ts'

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

function bearerAuthProvider(ctx: Context, rawRef: string) {
  const ref = credentialRef(rawRef)
  return {
    token: async (): Promise<string> => {
      const provider = ctx.get('credentials')
      if (provider === undefined) {
        throw new Error(`mcp-client: credential service unavailable while resolving "${ref}"`)
      }
      const resolved = await provider.resolve(ref)
      if (resolved === undefined) {
        throw new Error(`mcp-client: credential "${ref}" is not configured`)
      }
      return resolved.value
    },
  }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @param ctx - Optional Cordis context required only for credential-backed HTTP auth.
 * @returns A connected-ready MCP Transport (stdio or Streamable HTTP).
 */
export function createTransport(config: Config, ctx?: Context): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http': {
      if (config.bearerTokenRef !== undefined && ctx === undefined) {
        throw new Error('mcp-client: credential-backed Streamable HTTP transport requires a Cordis context')
      }
      const authProvider = config.bearerTokenRef === undefined
        ? undefined
        : bearerAuthProvider(ctx!, config.bearerTokenRef)
      // The MCP SDK's StreamableHTTPClientTransport has optional callback
      // properties typed without `| undefined` (exactOptionalPropertyTypes
      // mismatch with the Transport interface); the SDK constructed the
      // object, so the cast records only that widening.
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: { headers: config.headers },
          ...(authProvider === undefined ? {} : { authProvider }),
        },
      ) as Transport
    }
  }
}
