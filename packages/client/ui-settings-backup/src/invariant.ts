/**
 * Package-owned invariant companion for `@sparkelf/dsh-client-ui-settings-backup`.
 * @module @sparkelf/dsh-client-ui-settings-backup/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@sparkelf/dsh-client-ui-settings-backup'

/** Cordis companion plugin name. */
export const name = 'client-ui-settings-backup-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: browser-side surface plugin whose node half owns no
 * event stream or mutable runtime data; the backup archive contract is a
 * host contract covered in dsh-host-apiproxy.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
