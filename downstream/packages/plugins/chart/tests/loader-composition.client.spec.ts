// @vitest-environment jsdom
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as ChartClient from '../src/client/index.ts'
import { ChartRow } from '../src/client/ChartRow.tsx'
import { mountClientServices, type ClientSlotsFixture } from './client-services.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconInspectOutline12: () => null,
}))

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<{ ctx: Context; slots: ClientSlotsFixture }> {
  root = await mkdtemp(join(tmpdir(), 'sparkelf-chart-client-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@sparkelf/dsh-chart/client'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  const { slots } = await mountClientServices(ctx)

  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier !== '@sparkelf/dsh-chart/client') {
        throw new Error(`unexpected Loader import: ${specifier}`)
      }
      return ChartClient
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, slots }
}

describe('chart client real Loader composition through cordis.yml', () => {
  it('loads the keyed render_chart browser view through the public client entry', async () => {
    const { slots } = await boot()
    expect(slots.entries).toHaveLength(1)
    expect(slots.entries[0]!.component).toBe(ChartRow)
    expect(slots.entries[0]!.options).toMatchObject({
      name: 'tool.call.toolview',
      key: 'render_chart',
      locale: 'chart',
    })
  }, 30_000)
})
