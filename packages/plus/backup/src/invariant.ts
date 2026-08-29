/** Package invariant companion for `@sparkelf/dsh-plugin-backup`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@sparkelf/dsh-plugin-backup'

export const name = 'plus-backup-invariant'
export const inject = ['invariants']

/**
 * No runtime invariant: WebServer owns route registration, Workspace owns its
 * durable/cache relation, and the browser settings slot has no Host projection.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Host context carrying the invariant registry.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
