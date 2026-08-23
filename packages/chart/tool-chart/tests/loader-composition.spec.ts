import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolChart from '@deepseek-ai/dsh-tool-chart'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-chart-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-chart'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-chart', ToolChart],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('tool-chart real Loader composition through cordis.yml', () => {
  it('loads the real tool and preserves its replay metadata through the registry', async () => {
    const ctx = await boot()
    expect(ctx.tools.schemas().some(schema => schema.name === 'render_chart')).toBe(true)

    const option = { tooltip: {}, series: [{ type: 'pie', data: [{ name: 'A', value: 1 }] }] }
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-chart'),
      name: 'render_chart',
      arguments: { sourceResultRef: 'qr1_loader', option },
    })
    expect(result.isError).toBe(false)
    expect(result.meta).toEqual({ version: 1, sourceResultRef: 'qr1_loader', option })
  }, 30_000)
})
