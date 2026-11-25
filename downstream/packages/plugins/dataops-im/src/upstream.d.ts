/**
 * The pinned upstream package ships JavaScript without declarations. Only the host entry this
 * wrapper calls is declared; the version pin and the package's own `exports` map are the
 * contract for everything else.
 */
declare module '@xmanrui/dsh-im' {
  import type { Context } from '@deepseek-ai/cordis'
  export function apply(ctx: Context, config?: Record<string, unknown>): Promise<void>
}
