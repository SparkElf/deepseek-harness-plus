/**
 * `/ping` connectivity smoke command for DeepSeek Harness. Replies `pong`
 * without a model call, so it is keyless and safe in any composition.
 * Command types are self-contained because upstream dsh interaction packages
 * are not reliably published to npm; the runtime supplies the real seams.
 * @module @sparkelf/dsh-plugin-ping
 */

import type { Context } from '@deepseek-ai/cordis'

/** Invocation passed by the human-command adapter. */
export interface PingCommandInvocation {
  rawInput: string
  [key: string]: unknown
}

/** Result shape the command adapter expects. */
export interface PingCommandResult {
  kind: 'success' | 'error'
  text: string
  sourceEventSeq?: number
}

/** Registration definition consumed by the command registry. */
export interface PingCommandDefinition {
  name: string
  description: string
  handler: (invocation: PingCommandInvocation) => Promise<PingCommandResult>
}

/** Cordis plugin name. */
export const name = 'dsh-plugin-ping'
/** Command registry seam only. */
export const inject = ['commands']

/**
 * Register `/ping` for every composed human-command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.effect(function* () {
    yield (ctx as Context & { commands: { register: (definition: PingCommandDefinition) => () => unknown } }).commands.register({
      name: 'ping',
      description: 'Reply with pong; connectivity smoke command',
      handler: async (_invocation: PingCommandInvocation): Promise<PingCommandResult> => ({ kind: 'success', text: 'pong' }),
    })
  }, 'dsh-plugin-ping registration')
}
