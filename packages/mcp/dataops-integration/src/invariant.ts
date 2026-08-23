/** Package-owned invariant companion for `@deepseek-ai/dsh-mcp-dataops`. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-dataops'

export const name = 'mcp-dataops-invariant'
export const inject = ['invariants']

/** No runtime invariant: the package owns browser OAuth handoff and a child mcp-client fiber, not a separate durable projection. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
