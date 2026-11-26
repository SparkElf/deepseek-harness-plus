/**
 * External cockpit registry values and input checks.
 *
 * The external cockpit registry lives in DataOps. This module keeps the plugin's
 * view of a registry row narrow: ids, display metadata and a stable HTTPS link.
 * Login recipes, cookies, launch tickets and other secrets never cross the
 * browser or model boundary. It also owns the strict recipe/URL policy shared by
 * the Host broker and its tests.
 *
 * @module external
 */

/** Registry ids are opaque slugs/UUIDs, never paths or URLs. */
export const EXTERNAL_COCKPIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u

/** One external cockpit row exposed to tools and the sidebar. */
export interface ExternalCockpitRow {
  id: string
  name: string
  description: string | null
  /** Target site URL; only an absolute HTTPS URL is exposed. */
  url: string | null
  icon: string | null
  tags: string[]
  ownerId: string | null
  visibility: 'PRIVATE' | 'DEPARTMENT' | 'ALL'
  credentialType: 'http' | 'custom' | 'none'
  /** Account hint such as a username pattern; never a password. */
  credentialHint: string | null
  enabled: boolean
  health: string | null
  updatedAt: string | null
}

/** One page of external cockpit rows. */
export interface ExternalCockpitPage {
  items: ExternalCockpitRow[]
  total: number
  page: number
  pageSize: number
}

/** Stable link returned by `POST /api/external-cockpits/:id/link`. */
export interface ExternalCockpitLink {
  id: string
  url: string
  expiresAt: string | null
  mode: 'stable' | 'ticket'
}

/**
 * Accept one opaque registry id or fail before any URL is assembled.
 * @param value - Candidate id from a tool, route segment or caller.
 * @returns The trimmed id.
 */
export function assertExternalCockpitId(value: string): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!EXTERNAL_COCKPIT_ID_PATTERN.test(id)) {
    throw new Error('外部驾驶舱 id 非法：只接受注册表 id，不接受 URL 或路径')
  }
  return id
}

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

/** Keep only absolute HTTPS URLs; reject javascript/data/file and relative values. */
const httpsUrlOf = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.trim() === '') return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  return parsed.protocol === 'https:' ? parsed.toString() : null
}

const tagsOf = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const tags: string[] = []
  for (const item of value) {
    const tag = textOf(item)
    if (tag !== null && !tags.includes(tag)) tags.push(tag)
  }
  return tags.slice(0, 20)
}

const visibilityOf = (value: unknown): ExternalCockpitRow['visibility'] =>
  value === 'DEPARTMENT' || value === 'ALL' ? value : 'PRIVATE'

const credentialTypeOf = (value: unknown): ExternalCockpitRow['credentialType'] =>
  value === 'http' || value === 'custom' ? value : 'none'

/**
 * Narrow one unsanitized registry row to the fields the model and UI may see.
 * Extra backend fields (login recipe, cookies, allowed origins) are dropped.
 * @param value - Decoded JSON row from DataOps.
 * @returns Sanitized row.
 */
export function normalizeExternalCockpitRow(value: unknown): ExternalCockpitRow {
  const record = recordOf(value)
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!EXTERNAL_COCKPIT_ID_PATTERN.test(id)) throw new Error('外部驾驶舱数据缺少合法 id')
  const name = textOf(record.name)
  if (name === null) throw new Error('外部驾驶舱数据缺少名称')
  return {
    id,
    name,
    description: textOf(record.description),
    url: httpsUrlOf(record.url),
    icon: httpsUrlOf(record.icon),
    tags: tagsOf(record.tags),
    ownerId: textOf(record.ownerId),
    visibility: visibilityOf(record.visibility),
    credentialType: credentialTypeOf(record.credentialType),
    credentialHint: textOf(record.credentialHint),
    enabled: record.enabled !== false,
    health: textOf(record.health),
    updatedAt: textOf(record.updatedAt),
  }
}

/**
 * Normalize the list/detail envelope. Accepts `{items,...}` or a bare array.
 * @param value - Decoded JSON payload.
 * @param page - Requested page, used when the server omits it.
 * @param pageSize - Requested page size, used when the server omits it.
 * @returns Normalized page.
 */
export function normalizeExternalCockpitPage(value: unknown, page: number, pageSize: number): ExternalCockpitPage {
  const record = recordOf(value)
  const rawItems = Array.isArray(value) ? value : Array.isArray(record.items) ? record.items : []
  const items = rawItems.map(normalizeExternalCockpitRow)
  return {
    items,
    total: typeof record.total === 'number' && Number.isFinite(record.total) ? record.total : items.length,
    page: typeof record.page === 'number' && Number.isFinite(record.page) ? record.page : page,
    pageSize: typeof record.pageSize === 'number' && Number.isFinite(record.pageSize) ? record.pageSize : pageSize,
  }
}

/**
 * Normalize the link response. M1 consumes the stable HTTPS link only; a
 * launch ticket without a stable URL is an M2 feature and is rejected here.
 * @param value - Decoded JSON payload.
 * @param id - Registry id the link was requested for.
 * @returns Stable link with no ticket or cookie fields.
 */
export function normalizeExternalCockpitLink(value: unknown, id: string): ExternalCockpitLink {
  const record = recordOf(value)
  const candidate = record.url ?? record.link ?? record.stableUrl ?? record.openUrl ?? record.targetUrl ?? record.href
  const url = httpsUrlOf(candidate)
  if (url === null) {
    if (record.launchTicket !== undefined || record.ticket !== undefined) {
      throw new Error('DataOps 只返回了 launch ticket；M1 只支持稳定链接，登录代理在 M2')
    }
    throw new Error('DataOps 未返回可用的 HTTPS 稳定链接')
  }
  return {
    id: typeof record.id === 'string' && record.id.trim() !== '' ? record.id.trim() : id,
    url,
    expiresAt: textOf(record.expiresAt),
    mode: record.mode === 'ticket' ? 'ticket' : 'stable',
  }
}

/** Placeholders a login recipe may interpolate; values resolve inside the Host. */
export const EXTERNAL_RECIPE_PLACEHOLDERS = ['url', 'username', 'password', 'token', 'secret', 'secondary'] as const

/** One placeholder name accepted in a recipe template. */
export type ExternalRecipePlaceholder = (typeof EXTERNAL_RECIPE_PLACEHOLDERS)[number]

/** Canonical login step; aliases such as `waitForURL` normalize into this union. */
export type ExternalLoginStep =
  | { action: 'goto'; url: string }
  | { action: 'fill'; selector: string; value: string }
  | { action: 'click'; selector: string }
  | { action: 'waitForSelector'; selector: string }
  | { action: 'waitForURL'; pattern: string }
  | { action: 'wait'; ms: number }

/** Normalized admin-authored login recipe. It never contains a secret value. */
export interface ExternalLoginRecipe {
  version: 1
  steps: ExternalLoginStep[]
  /** Success evidence checked after the last step; empty means "final origin only". */
  success: { selector?: string; url?: string }
  timeoutMs: number
}

/** Registry detail narrowed for the Host broker; the recipe never reaches the browser. */
export interface ExternalCockpitHostDetail {
  cockpit: ExternalCockpitRow
  recipe: ExternalLoginRecipe | null
  /** Validation failure of an optional registry recipe; login fails closed on it. */
  recipeError: string | null
  allowedOrigins: string[]
}

/** Credential metadata returned to the panel for one cockpit site. */
export interface ExternalCredentialOption {
  id: string
  name: string
  type: string
  authKind: string
  username: string | null
  origin: string
  tags: string[]
  secretConfigured: boolean
}

/** Query that scopes credential listing to one cockpit type and site origin. */
export interface ExternalCredentialQuery {
  type: 'http' | 'custom'
  origin: string
}

/** Structural view of the credential-manager Host service; no package dependency. */
export interface ExternalCredentialService {
  listForSite(query: ExternalCredentialQuery): Promise<ExternalCredentialOption[]>
  describeForSite(credentialId: string, query: ExternalCredentialQuery): Promise<ExternalCredentialOption>
  readSecret(credentialId: string): Promise<Record<string, string> | undefined>
}

/** Navigation or recipe violated the external cockpit security rules. */
export class ExternalCockpitSecurityError extends Error {
  constructor(readonly code: 'NAVIGATION_BLOCKED' | 'RECIPE_INVALID', message: string) {
    super(message)
    this.name = 'ExternalCockpitSecurityError'
  }
}

const RECIPE_STEP_LIMIT = 20
const SELECTOR_MAX = 512
const TEMPLATE_MAX = 4096
const URL_TEMPLATE_MAX = 2048
const RECIPE_TIMEOUT_MIN = 1_000
const RECIPE_TIMEOUT_MAX = 120_000
const ORIGIN_LIMIT = 20

/** Reject control characters in selectors, URL patterns and templates. */
const assertPrintable = (value: string, field: string): string => {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error(field + ' 不能包含控制字符')
  return value
}

/** Read one recipe selector with its length limit. */
const recipeSelectorOf = (value: unknown, field: string): string => {
  const selector = typeof value === 'string' ? value.trim() : ''
  if (selector === '' || selector.length > SELECTOR_MAX) throw new Error(field + ' 必须是 1..' + String(SELECTOR_MAX) + ' 字符')
  return assertPrintable(selector, field)
}

/** Read one wait pattern (Playwright string or glob) with its length limit. */
const recipePatternOf = (value: unknown, field: string): string => {
  const pattern = typeof value === 'string' ? value.trim() : ''
  if (pattern === '' || pattern.length > SELECTOR_MAX) throw new Error(field + ' 必须是 1..' + String(SELECTOR_MAX) + ' 字符')
  return assertPrintable(pattern, field)
}

/** Validate placeholders in one template and return it unchanged. */
const recipeTemplateOf = (value: unknown, field: string, allowed: readonly ExternalRecipePlaceholder[]): string => {
  if (typeof value !== 'string' || value.length > TEMPLATE_MAX) throw new Error(field + ' 必须是字符串且不超过 ' + String(TEMPLATE_MAX) + ' 字符')
  assertPrintable(value, field)
  for (const match of value.matchAll(/\{\{([^{}]*)\}\}/gu)) {
    const name = (match[1] ?? '').trim()
    if (!(EXTERNAL_RECIPE_PLACEHOLDERS as readonly string[]).includes(name) || !allowed.includes(name as ExternalRecipePlaceholder)) {
      throw new Error(field + ' 含不允许的占位符：{{' + name + '}}')
    }
  }
  if (value.replace(/\{\{[^{}]*\}\}/gu, '').includes('{{')) throw new Error(field + ' 含未闭合的占位符')
  return value
}

/** Accept only an absolute HTTPS URL; reject credentials in the URL. */
const assertHttpsUrl = (value: string, field: string): URL => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(field + ' 必须是绝对 URL')
  }
  if (url.protocol !== 'https:') throw new Error(field + ' 只允许 HTTPS')
  if (url.username !== '' || url.password !== '') throw new Error(field + ' 不能包含账号或密码')
  return url
}

/** Normalize one recipe step; unknown actions and fields fail closed. */
const normalizeRecipeStep = (value: unknown, index: number): ExternalLoginStep => {
  const record = recordOf(value)
  const action = typeof record.action === 'string' ? record.action : ''
  const field = 'steps[' + String(index) + ']'
  switch (action) {
    case 'goto': {
      const url = recipeTemplateOf(record.url, field + '.url', ['url'])
      if (url.length > URL_TEMPLATE_MAX) throw new Error(field + '.url 过长')
      if (!url.includes('{{url}}')) assertHttpsUrl(url, field + '.url')
      return { action, url }
    }
    case 'fill':
      return {
        action,
        selector: recipeSelectorOf(record.selector, field + '.selector'),
        value: recipeTemplateOf(record.value, field + '.value', EXTERNAL_RECIPE_PLACEHOLDERS),
      }
    case 'click':
      return { action, selector: recipeSelectorOf(record.selector, field + '.selector') }
    case 'waitForSelector':
      return { action, selector: recipeSelectorOf(record.selector, field + '.selector') }
    case 'waitForURL':
      return { action, pattern: recipePatternOf(record.pattern ?? record.url, field + '.pattern') }
    case 'wait': {
      if (record.ms !== undefined) {
        const ms = Number(record.ms)
        if (!Number.isFinite(ms) || ms < 1 || ms > RECIPE_TIMEOUT_MAX) throw new Error(field + '.ms 超出范围')
        return { action, ms: Math.trunc(ms) }
      }
      if (record.selector !== undefined) return { action: 'waitForSelector', selector: recipeSelectorOf(record.selector, field + '.selector') }
      if (record.url !== undefined || record.pattern !== undefined) {
        return { action: 'waitForURL', pattern: recipePatternOf(record.url ?? record.pattern, field + '.url') }
      }
      throw new Error(field + ' 的 wait 需要 selector、url 或 ms 之一')
    }
    default:
      throw new Error(field + ' 不支持的动作：' + action)
  }
}

/**
 * Normalize an optional registry login recipe.
 * @param value - raw `loginRecipe` / `login_recipe` value.
 * @returns A validated recipe, or null when absent.
 */
export function normalizeExternalLoginRecipe(value: unknown): ExternalLoginRecipe | null {
  if (value === null || value === undefined) return null
  const record = recordOf(value)
  if (record.version !== 1) throw new Error('登录 recipe 的 version 必须为 1')
  const rawSteps = Array.isArray(record.steps) ? record.steps : []
  if (rawSteps.length === 0 || rawSteps.length > RECIPE_STEP_LIMIT) {
    throw new Error('登录 recipe 的 steps 必须是 1..' + String(RECIPE_STEP_LIMIT) + ' 步')
  }
  const steps = rawSteps.map((step, index) => normalizeRecipeStep(step, index))
  if (!steps.some((step) => step.action === 'goto')) throw new Error('登录 recipe 必须包含 goto 步骤')
  const rawTimeout = Number(record.timeoutMs ?? 30_000)
  const timeoutMs = Number.isFinite(rawTimeout)
    ? Math.max(RECIPE_TIMEOUT_MIN, Math.min(RECIPE_TIMEOUT_MAX, Math.trunc(rawTimeout)))
    : 30_000
  const successRecord = recordOf(record.success)
  const success: ExternalLoginRecipe['success'] = {}
  if (successRecord.selector !== undefined) success.selector = recipeSelectorOf(successRecord.selector, 'success.selector')
  if (successRecord.url !== undefined || successRecord.pattern !== undefined) {
    success.url = recipePatternOf(successRecord.url ?? successRecord.pattern, 'success.url')
  }
  return { version: 1, steps, success, timeoutMs }
}

/**
 * Normalize the registry allowlist to HTTPS origins and always include the cockpit URL.
 * @param value - raw `allowedOrigins` / `allowed_origins` value.
 * @param cockpitUrl - validated cockpit URL, or null.
 * @returns Unique HTTPS origins.
 */
export function normalizeExternalAllowedOrigins(value: unknown, cockpitUrl: string | null): string[] {
  const origins: string[] = []
  const add = (candidate: string, field: string): void => {
    const url = assertHttpsUrl(candidate.trim(), field)
    if (url.origin !== candidate.trim() && candidate.trim() !== url.origin + '/') {
      throw new Error(field + ' 必须是纯 origin，不能带路径、查询串或锚点')
    }
    if (!origins.includes(url.origin)) origins.push(url.origin)
  }
  if (cockpitUrl !== null) {
    const url = assertHttpsUrl(cockpitUrl, 'url')
    origins.push(url.origin)
  }
  if (Array.isArray(value)) {
    if (value.length > ORIGIN_LIMIT) throw new Error('allowedOrigins 最多 ' + String(ORIGIN_LIMIT) + ' 项')
    value.forEach((entry, index) => {
      if (typeof entry !== 'string' || entry.trim() === '') throw new Error('allowedOrigins[' + String(index) + '] 必须是字符串')
      add(entry, 'allowedOrigins[' + String(index) + ']')
    })
  } else if (value !== undefined && value !== null) {
    throw new Error('allowedOrigins 必须是数组')
  }
  return origins.slice(0, ORIGIN_LIMIT)
}

/** Resolve one recipe template; unknown or unavailable placeholders fail before launch. */
export function resolveExternalRecipeTemplate(
  template: string,
  values: Readonly<Record<ExternalRecipePlaceholder, string>>,
): string {
  return template.replace(/\{\{([^{}]*)\}\}/gu, (_match, rawName: string) => {
    const name = rawName.trim() as ExternalRecipePlaceholder
    if (!(EXTERNAL_RECIPE_PLACEHOLDERS as readonly string[]).includes(name)) {
      throw new Error('未知的 recipe 占位符：{{' + name + '}}')
    }
    const value = values[name]
    if (value === '') throw new Error('recipe 需要的凭据字段为空：' + name)
    return value
  })
}

/** Test an IPv4 literal against loopback, link-local and private ranges. */
const isPrivateIpv4 = (hostname: string): boolean => {
  const parts = hostname.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a = 0, b = 0] = parts
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
}

/** Test an IPv6 literal against loopback, link-local and unique-local ranges. */
const isPrivateIpv6 = (hostname: string): boolean => {
  const value = hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  if (value === '::1' || value === '::') return true
  if (value.startsWith('::ffff:')) {
    const tail = value.slice('::ffff:'.length)
    if (tail.includes('.')) return isPrivateIpv4(tail)
    const [high, low] = tail.split(':')
    const hi = Number.parseInt(high ?? '', 16)
    const lo = Number.parseInt(low ?? '', 16)
    if (Number.isInteger(hi) && Number.isInteger(lo)) {
      return isPrivateIpv4([(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.'))
    }
  }
  return value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')
}

/** Reject loopback, link-local, private and metadata hostnames. */
export function isPrivateExternalHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase().replace(/\.$/u, '')
  if (value === '' || value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local') || value.endsWith('.internal')) return true
  // Integer and hex IPv4 spellings resolve to an address; block them rather than guess.
  if (/^0x[0-9a-f]+$/iu.test(value) || /^\d+$/u.test(value)) return true
  if (value.startsWith('[') || value.includes(':')) return isPrivateIpv6(value)
  return isPrivateIpv4(value)
}

/**
 * Allow a request URL for the login page's subresources.
 * @param raw - absolute request URL from Playwright.
 * @returns True for HTTPS/WSS or browser-internal data/blob URLs on public hosts.
 */
export function externalSubresourceAllowed(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return true
  if (url.protocol !== 'https:' && url.protocol !== 'wss:') return false
  return !isPrivateExternalHost(url.hostname)
}

/**
 * Allow a top-level navigation only to an allowlisted HTTPS origin.
 * @param raw - navigation URL.
 * @param allowedOrigins - cockpit allowlist.
 * @returns True when the origin is allowlisted and public.
 */
export function externalNavigationAllowed(raw: string, allowedOrigins: readonly string[]): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || isPrivateExternalHost(url.hostname)) return false
  return allowedOrigins.includes(url.origin)
}

/** Throw when a recipe navigation leaves the allowlist. */
export function assertExternalNavigation(raw: string, allowedOrigins: readonly string[]): void {
  if (!externalNavigationAllowed(raw, allowedOrigins)) {
    throw new ExternalCockpitSecurityError('NAVIGATION_BLOCKED', '登录流程试图访问不在 allowlist 内的地址')
  }
}

/**
 * Extract recipe and allowlist from one raw registry detail response.
 * @param value - decoded DataOps detail JSON.
 * @returns Sanitized row plus Host-only recipe and origins.
 */
export function normalizeExternalCockpitHostDetail(value: unknown): ExternalCockpitHostDetail {
  const record = recordOf(value)
  const cockpit = normalizeExternalCockpitRow(record)
  let recipe: ExternalLoginRecipe | null = null
  let recipeError: string | null = null
  try {
    recipe = normalizeExternalLoginRecipe(record.loginRecipe ?? record.login_recipe)
  } catch (error) {
    // A malformed optional recipe must not break metadata reads; login refuses it.
    recipeError = error instanceof Error ? error.message : String(error)
  }
  return {
    cockpit,
    recipe,
    recipeError,
    allowedOrigins: normalizeExternalAllowedOrigins(record.allowedOrigins ?? record.allowed_origins, cockpit.url),
  }
}

/**
 * Choose the recipe for one cockpit: registry first, then the deployment config.
 * @param detail - registry detail carrying the optional recipe.
 * @param configured - `externalLoginRecipes` config map keyed by registry id.
 * @returns A validated recipe or null when neither source defines one.
 */
export function externalRecipeFor(
  detail: ExternalCockpitHostDetail,
  configured: Readonly<Record<string, unknown>>,
): ExternalLoginRecipe | null {
  if (detail.recipeError !== null) throw new Error('登录 recipe 非法：' + detail.recipeError)
  if (detail.recipe !== null) return detail.recipe
  const raw = configured[detail.cockpit.id]
  return raw === undefined ? null : normalizeExternalLoginRecipe(raw)
}

/** One public login session view; never contains cookies or storage state. */
export interface ExternalLoginSessionView {
  ok: true
  sessionId: string
  cockpitId: string
  cockpitName: string
  credentialId: string | null
  credentialName: string | null
  mode: 'headless' | 'headed'
  screenshotUrl: string
  finalOrigin: string
  expiresAt: string
}

/** Failure codes surfaced by the Host login broker and the panel. */
export type ExternalLoginErrorCode =
  | 'RECIPE_MISSING'
  | 'RECIPE_INVALID'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'SECRET_MISSING'
  | 'NAVIGATION_BLOCKED'
  | 'MFA_REQUIRED'
  | 'CAPTCHA_REQUIRED'
  | 'HEADED_DISABLED'
  | 'BROWSER_UNAVAILABLE'
  | 'TIMEOUT'
  | 'LOGIN_FAILED'

/** One failed login; the message is safe to show and never carries page text or a secret. */
export interface ExternalLoginFailure {
  ok: false
  code: ExternalLoginErrorCode
  message: string
  hint: string
  headedAvailable: boolean
}
