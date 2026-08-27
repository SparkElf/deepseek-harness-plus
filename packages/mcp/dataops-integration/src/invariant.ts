/** Package-owned invariant companion for `@deepseek-ai/dsh-mcp-dataops`. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-dataops'

/** Cordis plugin name for the DataOps invariant companion. */
export const name = 'mcp-dataops-invariant'
/** Services required to register the package invariant installer. */
export const inject = ['invariants']

/** No runtime invariant: the package owns browser OAuth handoff and a child mcp-client fiber, not a separate durable projection. */
const install: InvariantInstaller = () => {}

/**
 * Register the package's explained empty invariant installer.
 * @param ctx - Cordis context with the invariant registry.
 * @returns The registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
