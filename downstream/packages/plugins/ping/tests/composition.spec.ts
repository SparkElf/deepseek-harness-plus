import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as ping from '../src/index.ts'
import type { PingCommandDefinition } from '../src/index.ts'

/** Real cordis composition: the registry seam is stubbed, the runtime is real. */
describe('dsh-plugin-ping composition', () => {
  it('registers /ping through a real cordis Context', async () => {
    const registered: PingCommandDefinition[] = []
    const ctx = new Context()
    ctx.provide('commands', {
      register(definition: PingCommandDefinition) {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    } as never)
    const fiber = ctx.plugin(ping)
    await fiber
    expect(registered.map(def => def.name)).toEqual(['ping'])
    await expect(registered[0].handler({ rawInput: '' })).resolves.toMatchObject({ kind: 'success', text: 'pong' })
    await fiber.dispose()
    expect(registered).toHaveLength(0)
  })
})
