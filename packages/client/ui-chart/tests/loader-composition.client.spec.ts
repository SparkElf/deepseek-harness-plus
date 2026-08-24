import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import * as UiChart from '../src/client/index.ts'
import { ChartRow } from '../src/client/ChartRow.tsx'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<{ ctx: Context; slots: SlotRegistry }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-ui-chart-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-client-ui-chart'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    },
  } as never, () => null)

  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier !== '@deepseek-ai/dsh-client-ui-chart') {
        throw new Error(`unexpected Loader import: ${specifier}`)
      }
      return UiChart
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, slots }
}

describe('ui-chart real Loader composition through cordis.yml', () => {
  it('loads the keyed render_chart browser view through the real plugin entry', async () => {
    const { slots } = await boot()
    const entries = slots.entries('tool.call.toolview')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.component).toBe(ChartRow)
    expect(entries[0]!.options).toMatchObject({ key: 'render_chart', locale: 'chart' })
  }, 30_000)
})
