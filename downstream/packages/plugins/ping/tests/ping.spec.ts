import { describe, expect, it } from 'vitest'
import { apply, inject, name, type PingCommandDefinition } from '../src/index.ts'

/** Minimal context stand-in exercising the effect/registration contract. */
function fakeContext() {
  const registered: PingCommandDefinition[] = []
  const disposers: Array<() => unknown> = []
  const ctx = {
    effect(generator: () => Generator<() => unknown>, _label: string) {
      const iterator = generator()
      for (let step = iterator.next(); !step.done; step = iterator.next()) disposers.push(step.value)
    },
    commands: {
      register(definition: PingCommandDefinition) {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
  }
  return { ctx, registered, disposers }
}

describe('dsh-plugin-ping', () => {
  it('declares the cordis plugin surface', () => {
    expect(name).toBe('dsh-plugin-ping')
    expect(inject).toEqual(['commands'])
  })

  it('registers /ping and replies pong without a model', async () => {
    const { ctx, registered, disposers } = fakeContext()
    apply(ctx as never)
    expect(registered).toHaveLength(1)
    expect(registered[0].name).toBe('ping')
    await expect(registered[0].handler({ rawInput: '' })).resolves.toEqual({ kind: 'success', text: 'pong' })
    for (const dispose of disposers) dispose()
    expect(registered).toHaveLength(0)
  })
})
