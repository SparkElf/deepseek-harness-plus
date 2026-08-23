/** Package-owned invariant companion for the stateless chart tool. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-chart'

export const name = 'tool-chart-invariant'
export const inject = ['invariants']

/** The chart tool owns no independent mutable state or session event relation beyond tool/result metadata. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
