/**
 * The same-origin API surface shared by this package's two halves.
 *
 * The Host registers one prefix and dispatches on the trailing method name; the browser
 * calls the same strings. Keeping them in one module is what stops the two halves
 * drifting apart -- the failure mode knowledge-base recorded when its panel called
 * `/knowledge-base/config` while its Host served `/knowledge-base/api/config`.
 *
 * The namespace is `ocr` rather than a shared one, so this route can never collide with
 * the knowledge base's `/knowledge-base/api/*` or any other plugin's prefix.
 *
 * This module must stay dependency-free so both bundles can import it: the Client bundle
 * rejects Node builtins and non-platform packages.
 *
 * @module @sparkelf/dsh-ocr/api
 */

/** Prefix the Host registers and the browser calls. */
export const OCR_API_PREFIX = '/ocr/api'

/** Method names the Host dispatches on. */
export const OCR_API = {
  /** The shared MinerU address plus whether the caller may change it. */
  config: 'config',
  /** How many members a distribution reaches, and how many it would replace. */
  impact: 'impact',
  /** Fill only members that hold no address of their own. */
  distributeDefault: 'distribute-default',
  /** Replace every member's address, including ones they chose themselves. */
  overwrite: 'overwrite',
  /**
   * Probe a MinerU address before saving it.
   *
   * Not a backend route: the Host answers this one itself, because only this process can
   * reach the address from inside the workspace network. It still reads the stored config
   * through the backend first, so a caller who may not edit cannot make the relay fetch an
   * arbitrary URL.
   */
  testConnection: 'test-connection',
} as const

/** One valid method name. */
export type OcrApiMethod = typeof OCR_API[keyof typeof OCR_API]

/**
 * Build the browser path for one method.
 * @param method - one of {@link OCR_API}.
 * @returns the same-origin path the Host dispatches on.
 */
export function ocrApiPath(method: OcrApiMethod): string {
  return `${OCR_API_PREFIX}/${method}`
}

/**
 * The shared configuration as the settings page reads it.
 *
 * `mineruUrl === ''` is "not configured yet", not an error: a deployment is allowed to
 * have never had an OCR address. `canEdit` decides between two renderings of the same
 * page and never whether the address may be USED -- every signed-in member can recognize
 * documents with the shared value.
 */
export interface OcrConfigView {
  /** The shared MinerU base address, or `''` when none is stored. */
  mineruUrl: string
  /** Whether the caller holds the one role this deployment lets change the shared value. */
  canEdit: boolean
}

/**
 * How many members a distribution reaches.
 *
 * `withValue` is what an overwrite would replace while `onlyIfEmpty` would skip it, so
 * the confirmation can name the number it is about to disturb instead of asking "are you
 * sure?" with no quantity.
 */
export interface OcrImpactView {
  /** Members who already hold an address of their own. */
  withValue: number
  /** Members who hold none; `onlyIfEmpty` fills exactly these. */
  withoutValue: number
  /** Every member the distribution considers. */
  total: number
}

/** Per-bucket counts one distribution reports back. */
export interface OcrDistributionView {
  /** `onlyIfEmpty` or `force`, as the backend names the two modes. */
  mode?: string
  /** Members written. */
  filled: number
  /** Members left alone. */
  skipped: number
  /** Members whose write failed. */
  failed: number
  /** Every member considered. */
  total: number
}

/**
 * A refusal the page must show rather than swallow.
 *
 * The two write routes answer 400 for an empty address and 403 for a caller without the
 * role. Both are decisions, so the page reports them instead of retrying.
 */
export interface OcrErrorView {
  /** The backend's own message, already in the reader's language. */
  error: string
}

/** Why a probe ended as it did. The page maps these codes to locale copy. */
export type OcrProbeCode =
  /** The address answered as a MinerU service. */
  | 'ok'
  /** Not an absolute http(s) address, so there is nothing to call. */
  | 'bad-url'
  /** No answer inside the probe window. */
  | 'timeout'
  /** The connection was refused, DNS failed, or the host is unreachable. */
  | 'unreachable'
  /** An HTTP server answered, but its OpenAPI document is not MinerU's. */
  | 'not-mineru'
  /** The service answered with a non-2xx status. */
  | 'http-error'

/**
 * What a connection test reports.
 *
 * `latencyMs` is measured around the probe request, not the whole redirect chain: a
 * number that included the backend round trip would blame the MinerU box for the relay's
 * latency. `testedUrl` is echoed because the caller may have typed a candidate before
 * saving, and the panel has to label which address the tag refers to.
 */
export interface OcrProbeView {
  /** Whether the address is a reachable MinerU service. */
  ok: boolean
  /** Round-trip time of the probe request, in milliseconds. */
  latencyMs: number
  /** Machine-readable outcome. */
  code: OcrProbeCode
  /** The address that was actually tested. */
  testedUrl: string
  /** HTTP status when a response arrived. */
  status?: number
  /** A short technical detail, for the tooltip and the operator. */
  message?: string
}
