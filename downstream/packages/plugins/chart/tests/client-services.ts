import { Context, Service } from '@deepseek-ai/cordis'

interface TestSlotEntry {
  options: Record<string, unknown>
  component: unknown
}

/** Minimal Cordis services for exercising an external client plugin without importing Harness browser bundles as Node ESM. */
export class ClientSlotsFixture extends Service {
  readonly entries: TestSlotEntry[] = []

  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  inject(_key: string, callback: () => (() => void)): () => void {
    const dispose = this.ctx.effect(callback, 'chart-test: slot injection')
    return () => { void dispose() }
  }

  register(options: Record<string, unknown>, component: unknown): () => void {
    const entry = { options, component }
    this.entries.push(entry)
    return () => {
      const index = this.entries.indexOf(entry)
      if (index >= 0) this.entries.splice(index, 1)
    }
  }
}

export class ClientLocaleFixture extends Service {
  readonly namespaces = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'locale')
  }

  register(namespace: string, _dictionaries: unknown): () => void {
    this.namespaces.add(namespace)
    return () => { this.namespaces.delete(namespace) }
  }
}

export async function mountClientServices(ctx: Context): Promise<{
  slots: ClientSlotsFixture
  locale: ClientLocaleFixture
}> {
  await ctx.plugin(ClientSlotsFixture).await()
  await ctx.plugin(ClientLocaleFixture).await()
  return {
    slots: ctx.get('slots') as unknown as ClientSlotsFixture,
    locale: ctx.get('locale') as unknown as ClientLocaleFixture,
  }
}
