/**
 * The workspace brand the shell mirrors.
 *
 * DataOps owns two names and one shared logo. `platform/brand_name` names the portal, while the
 * workspace renders `platform/workspace_brand_name` and `platform/brand_logo`. All three are
 * public because the workspace renders its shell before — and without — a DataOps session, so
 * this module deliberately carries no credential and never asks for one. A deployment that has
 * not set a key keeps the shell's own default.
 */

/** One brand the shell can render. */
export interface WorkspaceBranding {
  /** AI workspace name shown in the wordmark and the browser title. */
  name: string
  /** Inline image data URL or an absolute path; empty asks the shell for its inline mark. */
  logo: string
}

/** The name the workspace has always shown when DataOps has no workspace brand of its own. */
export const DEFAULT_WORKSPACE_BRAND_NAME = '万相AI中台'

/** Brand used when DataOps is unreachable, unconfigured, or answers with an unusable value. */
export const DEFAULT_WORKSPACE_BRANDING: WorkspaceBranding = {
  name: DEFAULT_WORKSPACE_BRAND_NAME,
  logo: '',
}

/** Public setting that carries the portal name; the workspace does not render it. */
export const BRAND_NAME_SETTING_PATH = '/api/system/settings/public/platform/brand_name'
/** Public setting that carries the AI workspace name. */
export const WORKSPACE_BRAND_NAME_SETTING_PATH = '/api/system/settings/public/platform/workspace_brand_name'
/** Public setting that carries the logo both surfaces share. */
export const BRAND_LOGO_SETTING_PATH = '/api/system/settings/public/platform/brand_logo'

/** How long one successful read serves later requests before asking DataOps again. */
export const BRANDING_CACHE_TTL_MS = 10_000
/** How long a failed read serves the default before another attempt, so an outage is not retried per request. */
export const BRANDING_FAILURE_TTL_MS = 3_000
/** Upper bound on one public-settings request; the shell must never wait on branding. */
export const BRANDING_REQUEST_TIMEOUT_MS = 5_000

/** Same length the portal's own brand-name field enforces. */
const BRAND_NAME_MAX_LENGTH = 32

/** Inline logo formats the portal's uploader produces, plus SVG for deployments that seed one. */
const INLINE_LOGO_PATTERN = /^data:image\/(?:png|jpe?g|webp|svg\+xml);base64,[a-z0-9+/=]+$/iu

/**
 * Paths the portal uses for its default mark.
 *
 * The workspace already draws that mark itself and follows the host theme through `currentColor`,
 * so a default path is treated as "no custom logo" rather than as an image the workspace origin
 * cannot serve.
 */
const DEFAULT_LOGO_PATHS = new Set([
  '/logo-mark.svg',
  '/logo-text.png',
  '/logo-cube.svg',
  '/logo-cube-mono.svg',
])

/** Narrow an unknown value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Normalize a brand name; empty or unusable values keep the workspace default.
 * @param value - Raw setting value.
 * @returns A non-empty display name no longer than the portal's own limit.
 */
export function normalizeWorkspaceBrandName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_WORKSPACE_BRAND_NAME
  const name = value.replace(/\s+/gu, ' ').trim().slice(0, BRAND_NAME_MAX_LENGTH)
  return name === '' ? DEFAULT_WORKSPACE_BRAND_NAME : name
}

/**
 * Normalize a brand logo to the two forms the shell renders.
 *
 * Only inline image data URLs and same-deployment absolute paths are accepted. Anything else
 * (script URLs, protocol-relative URLs, remote origins) becomes "no logo" so the inline mark
 * stays the fallback instead of loading an untrusted resource.
 * @param value - Raw setting value.
 * @returns A data URL, an absolute path, or an empty string.
 */
export function normalizeWorkspaceBrandLogo(value: unknown): string {
  if (typeof value !== 'string') return ''
  const logo = value.trim()
  if (logo === '' || DEFAULT_LOGO_PATHS.has(logo)) return ''
  if (INLINE_LOGO_PATTERN.test(logo)) return logo
  if (logo.startsWith('/') && !logo.startsWith('//') && logo.length <= 4096) return logo
  return ''
}

/**
 * Resolve a configured logo path against the browser-facing DataOps origin.
 *
 * The portal stores custom logos as data URLs, but a deployment may seed an absolute path such
 * as `/brands/logo.png`. A path copied into the workspace page would resolve against the DSH
 * origin, where the portal's files do not exist, so the Host prefixes the portal origin it
 * already receives through `webBaseUrl`.
 * @param logo - Normalized logo: empty, a data URL, or an absolute path.
 * @param webBaseUrl - Browser-facing DataOps origin, possibly a comma-separated list.
 * @returns The logo the browser can load, unchanged when no portal origin is configured.
 */
export function resolveWorkspaceBrandLogo(logo: string, webBaseUrl: string | undefined): string {
  if (logo === '' || logo.startsWith('data:')) return logo
  if (!logo.startsWith('/') || logo.startsWith('//')) return logo
  const configured = (webBaseUrl ?? '')
    .split(',')
    .map(value => value.trim())
    .find(value => value !== '' && URL.canParse(value))
  if (configured === undefined) return logo
  return new URL(logo, new URL(configured).origin).href
}

/**
 * Read one public setting without a credential.
 * @param baseUrl - DataOps API origin.
 * @param path - Public settings path.
 * @param fetcher - Fetch implementation, injectable for tests.
 * @returns The stored string, or an empty string when the key is unset.
 * @throws When DataOps cannot be reached or answers outside the public-settings contract.
 */
async function readPublicSetting(
  baseUrl: string,
  path: string,
  fetcher: typeof fetch,
): Promise<string> {
  const response = await fetcher(new URL(path, baseUrl), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(BRANDING_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`public setting ${path} answered HTTP ${String(response.status)}`)
  const payload = asRecord(await response.json() as unknown)
  if (payload === null || !('setting' in payload)) {
    throw new Error(`public setting ${path} answered outside its contract`)
  }
  if (payload['setting'] === null) return ''
  const setting = asRecord(payload['setting'])
  const value = setting?.['value']
  if (typeof value !== 'string') {
    throw new Error(`public setting ${path} did not carry a string value`)
  }
  return value
}

/**
 * Short-lived read-through cache over the public brand settings.
 *
 * The shell asks on startup and then periodically; a ten-second window keeps a page reload
 * from adding a database read while still letting an administrator's save reach an open
 * workspace without a refresh.
 */
export class WorkspaceBrandingSource {
  private cached: { value: WorkspaceBranding; expiresAt: number } | undefined

  /**
   * @param baseUrl - DataOps API origin, taken from the plugin's existing `baseUrl` config.
   * @param options - Clock and fetch overrides for tests.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly options: {
      now?: () => number
      fetcher?: typeof fetch
    } = {},
  ) {}

  /**
   * Read the brand, falling back to the hardcoded default on any failure.
   * @returns The brand to render; never throws.
   */
  async read(): Promise<WorkspaceBranding> {
    const now = (this.options.now ?? Date.now)()
    if (this.cached !== undefined && this.cached.expiresAt > now) return this.cached.value
    const fetcher = this.options.fetcher ?? fetch
    try {
      // The portal name is read with the other two settings so the public brand surface either
      // answers as a whole or falls back as a whole; the workspace never borrows that name.
      const [, workspaceName, logo] = await Promise.all([
        readPublicSetting(this.baseUrl, BRAND_NAME_SETTING_PATH, fetcher),
        readPublicSetting(this.baseUrl, WORKSPACE_BRAND_NAME_SETTING_PATH, fetcher),
        readPublicSetting(this.baseUrl, BRAND_LOGO_SETTING_PATH, fetcher),
      ])
      const value: WorkspaceBranding = {
        name: normalizeWorkspaceBrandName(workspaceName),
        logo: normalizeWorkspaceBrandLogo(logo),
      }
      this.cached = { value, expiresAt: now + BRANDING_CACHE_TTL_MS }
      return value
    } catch {
      this.cached = { value: DEFAULT_WORKSPACE_BRANDING, expiresAt: now + BRANDING_FAILURE_TTL_MS }
      return DEFAULT_WORKSPACE_BRANDING
    }
  }
}