/** Package-owned invariant companion for the browser-only chart UI. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-chart'

export const name = 'client-ui-chart-invariant'
export const inject = ['invariants']

/**
 * No runtime invariant: this browser plugin contributes a keyed render slot and owns no durable
 * state or independent event/data relation.
 */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
