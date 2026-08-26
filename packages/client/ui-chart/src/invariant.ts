/** Package-owned invariant companion for the browser-only chart UI. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-chart'

export const name = 'client-ui-chart-invariant'
export const inject = ['invariants']

// No runtime invariant: browser slot registration has no Host event or data relation to inspect.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
