/**
 * Real-composition guard for the dormant pi-ai posture: LlmRuntime,
 * settings-file, credentials-local, and a bare `llm-pi-ai` row boot from a
 * test-only cordis.yml through the actual Loader + Include path, an external
 * edit of settings.yaml registers the route live, and the next request
 * carries the credential the credentials document supplies. A hand-mounted `ctx.plugin` cannot
 * catch Loader export-shape failures, which is why the twin adapter has the
 * same guard.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
})

/** Boot the dormant composition: a bare `llm-pi-ai` row with no config at all. */
async function loadComposition(): Promise<{ ctx: Context; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-composition-'))
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, '# personal settings\n')
  await writeFile(join(root, '.credentials.yaml'), 'PI_COMPOSITION_KEY: key-from-store\n', { mode: 0o600 })

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: settings',
    "  name: '@deepseek-ai/dsh-settings-file'",
    '  config:',
    `    path: ${JSON.stringify(settingsPath)}`,
    '    debounceMs: 10',
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
    '    debounceMs: 10',
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, settingsPath }
}

describe('llm-pi-ai real dormant composition', () => {
  it('boots with zero routes and registers one the moment settings supply a profile', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath } = await loadComposition()

    // The shipped posture: the adapter exists, no route does.
    expect(ctx.llm.listProviders()).toEqual([])

    // Exactly what the web Models page leaves on disk.
    await writeFile(settingsPath, [
      'llm-pi-ai:',
      '  providers:',
      '    deepseek:',
      '      apiKeyEnv: PI_COMPOSITION_KEY',
      `      baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer key-from-store')
  })

  it('applies the Responses reasoning-status option from the settings document', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{
      status: 400,
      body: JSON.stringify({ error: { message: 'expected mock failure' } }),
    }])
    const { ctx, settingsPath } = await loadComposition()
    await writeFile(settingsPath, [
      'llm-pi-ai:',
      '  providers:',
      '    compatible-gateway:',
      '      apiKeyEnv: PI_COMPOSITION_KEY',
      '      api: openai-responses',
      `      baseURL: ${server.url}/v1`,
      '      models:',
      '        - id: compatible-model',
      '          contextWindow: 65536',
      '          maxTokens: 4096',
      '      responsesCompatibility:',
      '        omitReasoningInputStatus: true',
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['compatible-gateway'])
    }, { timeout: 5000 })

    const result = await assemble(ctx, {
      provider: 'compatible-gateway',
      model: 'compatible-model',
      messages: [createAssistantMessage({
        content: [{ type: 'reasoning', text: 'summary' }, { type: 'text', text: 'answer' }],
        source: {
          provider: 'compatible-gateway',
          model: 'compatible-model',
          replayState: {
            kind: 'pi-ai',
            version: 1,
            api: 'openai-responses',
            provider: 'compatible-gateway',
            model: 'compatible-model',
            stopReason: 'stop',
            blocks: [
              {
                type: 'reasoning',
                thinkingSignature: JSON.stringify({
                  type: 'reasoning',
                  id: 'rs_composition',
                  summary: [],
                  status: 'completed',
                }),
              },
              { type: 'text', textSignature: JSON.stringify({ v: 1, id: 'msg_composition' }) },
            ],
          },
        },
      })],
    })
    expect(result.finish).toMatchObject({ kind: 'error' })
    const input = (server.requests[0] as { input: Record<string, unknown>[] }).input
    expect(input.find(item => item.type === 'reasoning')).not.toHaveProperty('status')
    expect(input.find(item => item.type === 'message')).toMatchObject({ status: 'completed' })
  })
})
