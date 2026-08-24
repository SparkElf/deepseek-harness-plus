/** Package-owned invariant companion for `@deepseek-ai/dsh-document-parser-mineru`. @module @deepseek-ai/dsh-document-parser-mineru/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-document-parser-mineru'

/** Cordis companion plugin name. */
export const name = 'document-parser-mineru-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: parse transport has no independent durable state beyond attachment refs validated by its consumers. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
