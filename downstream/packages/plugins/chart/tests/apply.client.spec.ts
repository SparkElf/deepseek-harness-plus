// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { ChartRow } from '../src/client/ChartRow.tsx'
import { mountClientServices } from './client-services.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconInspectOutline12: () => null,
}))

describe('chart client apply', () => {
  it('registers one localized keyed render_chart view and disposes it with the fiber', async () => {
    const ctx = new Context()
    const { slots, locale } = await mountClientServices(ctx)

    expect(inject).toEqual(['slots', 'locale'])
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(slots.entries).toHaveLength(1)
    expect(slots.entries[0]!.component).toBe(ChartRow)
    expect(slots.entries[0]!.options).toMatchObject({
      name: 'tool.call.toolview',
      key: 'render_chart',
      locale: 'chart',
    })
    expect(locale.namespaces.has('chart')).toBe(true)

    await fiber.dispose()
    expect(slots.entries).toHaveLength(0)
    expect(locale.namespaces.has('chart')).toBe(false)
    await ctx.fiber.dispose()
  })
})
