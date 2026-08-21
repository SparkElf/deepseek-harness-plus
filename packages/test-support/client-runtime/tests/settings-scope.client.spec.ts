import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '../src/settings-scope.ts'

describe('stubSettingsScope', () => {
  it('records complete replacements and publishes until the listener unsubscribes', async () => {
    const stub = stubSettingsScope<{ preference: string }>()
    const listener = vi.fn()
    const unsubscribe = stub.scope.subscribe(listener)

    expect(stub.listenerCount()).toBe(1)
    await expect(stub.scope.replace({ preference: 'dark' })).resolves.toBe(true)
    expect(stub.replace).toHaveBeenCalledWith({ preference: 'dark' })

    stub.publish({ status: 'ready', value: { preference: 'dark' }, writable: true })
    expect(listener).toHaveBeenCalledOnce()
    expect(stub.scope.getSnapshot()).toMatchObject({
      status: 'ready',
      value: { preference: 'dark' },
      writable: true,
    })

    unsubscribe()
    stub.publish({ writable: false })
    expect(stub.listenerCount()).toBe(0)
    expect(listener).toHaveBeenCalledOnce()
  })
})
