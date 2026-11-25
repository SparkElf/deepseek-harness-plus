/**
 * Host configuration for the artifact-app plugin.
 *
 * `baseUrl` is the DataOps API the host calls server-side; `webBaseUrl` is the
 * browser-facing DataOps frontend, only used to explain where the embed page
 * lives. The credential ref is shared with `dataops-managed`, so a managed
 * workspace signs in once.
 *
 * @module config
 */

import z from '@deepseek-ai/schemastery'

/** Host-side artifact-app settings. */
export interface Config {
  /** DataOps API origin, e.g. `http://host.docker.internal:3101`. */
  baseUrl: string
  /** Browser-reachable DataOps frontend origin; empty derives it from the request. */
  webBaseUrl: string
  /** Credential reference holding the workspace's DataOps JWT. */
  credentialRef: string
  /** Maximum accepted cockpit HTML size. */
  htmlMaxBytes: number
  /** Inject ECharts with the runtime; false only for tests. */
  injectRuntime: boolean
  /** Root the `html_path` tool arguments resolve against. */
  workspaceRoot: string
  /** Upstream timeout for one DataOps call. */
  requestTimeoutMs: number
}

/** Schemastery parser for the artifact-app config. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().default('http://host.docker.internal:3101'),
  webBaseUrl: z.string().default(''),
  credentialRef: z.string().default('DATAOPS_ACCESS_TOKEN'),
  htmlMaxBytes: z.number().default(100 * 1024 * 1024),
  injectRuntime: z.boolean().default(true),
  workspaceRoot: z.string().default('/workspace'),
  requestTimeoutMs: z.number().default(30_000),
})