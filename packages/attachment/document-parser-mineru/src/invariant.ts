/** Package-owned invariant companion for `@deepseek-ai/dsh-document-parser-mineru`. @module @deepseek-ai/dsh-document-parser-mineru/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-document-parser-mineru'

export const name = 'document-parser-mineru-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
