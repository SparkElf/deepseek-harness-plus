import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import { DataOpsSection } from '../src/client/DataOpsSection.tsx'

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
      'settings.section': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  return { ctx, locale, slots }
}

describe('mcp-dataops client apply', () => {
  it('declares only the browser services it consumes', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers one locale-following DataOps settings page and removes it with the fiber', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entries = b.slots.entries('settings.section')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.component).toBe(DataOpsSection)
    expect(entries[0]!.options).toMatchObject({ id: 'dataops', order: 30 })
    expect(resolveSlotLabel(entries[0]!.options.label)).toBe('DataOps')

    const injected = entries[0]!.inject as unknown as () => { t: (key: 'intro') => string }
    expect(injected().t('intro')).toContain('Harness')
    b.locale.setLocale('en')
    expect(injected().t('intro')).toContain('Connect Harness to DataOps')

    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
  })
})
