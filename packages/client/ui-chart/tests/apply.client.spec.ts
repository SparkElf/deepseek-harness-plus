import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import { ChartRow } from '../src/client/ChartRow.tsx'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    },
  } as never, () => null)
  return { ctx, slots }
}

describe('ui-chart client apply', () => {
  it('registers one localized keyed render_chart view and disposes it with the fiber', async () => {
    const b = await bench()
    expect(inject).toEqual(['slots', 'locale'])
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entries = b.slots.entries('tool.call.toolview')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.component).toBe(ChartRow)
    expect(entries[0]!.options).toMatchObject({ key: 'render_chart', locale: 'chart' })

    await fiber.dispose()
    expect(b.slots.entries('tool.call.toolview')).toHaveLength(0)
    await b.ctx.fiber.dispose()
  })
})
