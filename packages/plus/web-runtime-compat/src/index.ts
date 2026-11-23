/**
 * Publish the pre-0.2.3 `webRuntime` service beside `webStartup`.
 *
 * 0.2.3 renamed the bind-dependent provider to `webStartup`. Third-party bundles
 * that still inject `webRuntime` would stay pending forever, so this row rebuilds
 * the old shape from the new services: the sampled LAN literals for a wildcard
 * bind plus the deployment's own trusted hosts.
 * @module @sparkelf/dsh-web-runtime-compat
 */
import { networkInterfaces } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'

/** Stable plugin name. */
export const name = 'web-runtime-compat'

/** `webStartup` supplies the flags; `webServer` reports the bound host. */
export const inject = ['webStartup', 'webServer']

/** The pre-0.2.3 service shape. */
export interface WebRuntimeCompat {
  /** Non-internal IPv4 literals sampled from a wildcard bind. */
  readonly lanAddresses: readonly string[]
  /** Authorities this deployment serves, as the old row exposed them. */
  readonly trustedHosts: readonly string[]
}

/**
 * Publish `webRuntime` for the lifetime of this plugin.
 * @param ctx - plugin context injecting the startup and server services.
 */
export function apply(ctx: Context): void {
  const server = ctx.get('webServer') as { host?: string } | undefined
  const startup = ctx.get('webStartup') as { trustedHosts?: readonly string[] } | undefined
  const boundHost = server?.host ?? ''
  const wildcard = boundHost === '' || boundHost === '0.0.0.0' || boundHost === '::'
  const lanAddresses = wildcard
    ? Object.values(networkInterfaces()).flat()
      .filter((iface): iface is NonNullable<typeof iface> => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
      .map(iface => iface.address)
    : []
  ctx.provide('webRuntime', {
    lanAddresses,
    trustedHosts: [...lanAddresses, ...startup?.trustedHosts ?? []],
  } satisfies WebRuntimeCompat)
}
