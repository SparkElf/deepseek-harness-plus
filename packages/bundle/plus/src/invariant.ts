/**
 * Package-owned invariant companion for `@sparkelf/dsh-plus`.
 * @module @sparkelf/dsh-plus/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@sparkelf/dsh-plus'

/** Cordis companion plugin name. */
export const name = 'plus-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: this package carries static profile and patchset data.
// The resolver validates those files before a candidate build, while every
// mounted plugin owns its runtime relationships.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
