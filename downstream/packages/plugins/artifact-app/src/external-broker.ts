/**
 * Host-side external cockpit login broker.
 *
 * One login launches one Playwright browser and one fresh browser context, runs
 * an admin-authored recipe, captures a screenshot and the context's storage
 * state, then closes the browser. The storage state and screenshot live only in
 * this process, bound to an unguessable session id and a browser-session client
 * id; they expire after the configured TTL and are never serialized to disk.
 *
 * The broker accepts a registry row plus a normalized recipe, never a free-form
 * URL. Secret values reach only `page.fill`; they are not logged, audited,
 * returned, or embedded in a session view.
 *
 * @module external-broker
 */

import { randomBytes } from 'node:crypto'
import {
  ExternalCockpitSecurityError,
  assertExternalNavigation,
  externalNavigationAllowed,
  externalSubresourceAllowed,
  resolveExternalRecipeTemplate,
  type ExternalCockpitRow,
  type ExternalLoginErrorCode,
  type ExternalLoginRecipe,
  type ExternalLoginSessionView,
  type ExternalRecipePlaceholder,
} from './external.ts'
import { EXTERNAL_COCKPITS_PATH } from './open-hub.ts'

/** Minimal Playwright surface the broker drives; tests provide a fake. */
type PlaywrightFrame = object

interface PlaywrightRequest {
  url(): string
  isNavigationRequest(): boolean
  frame(): PlaywrightFrame
}

interface PlaywrightRoute {
  request(): PlaywrightRequest
  abort(reason?: string): Promise<void>
  continue(): Promise<void>
}

interface PlaywrightPage {
  url(): string
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>
  fill(selector: string, value: string, options: { timeout: number }): Promise<void>
  click(selector: string, options: { timeout: number }): Promise<void>
  waitForSelector(selector: string, options: { timeout: number; state?: 'visible' }): Promise<unknown>
  waitForURL(pattern: string, options: { timeout: number }): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  screenshot(options: { type: 'png'; fullPage?: boolean }): Promise<Buffer>
  evaluate<T>(pageFunction: () => T): Promise<T>
  mainFrame(): PlaywrightFrame
  route(url: string, handler: (route: PlaywrightRoute) => void): Promise<void>
}

interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>
  storageState(): Promise<unknown>
  close(): Promise<void>
}

interface PlaywrightBrowser {
  newContext(options: Record<string, unknown>): Promise<PlaywrightContext>
  close(): Promise<void>
}

interface PlaywrightModule {
  chromium: {
    launch(options: { headless: boolean }): Promise<PlaywrightBrowser>
  }
}

/** Everything the broker needs from one login request. */
export interface ExternalLoginInput {
  cockpit: ExternalCockpitRow
  recipe: ExternalLoginRecipe
  allowedOrigins: string[]
  credential: {
    id: string | null
    name: string | null
    username: string | null
    secret: Record<string, string>
  }
  mode: 'headless' | 'headed'
  /** Browser-session id from the panel; isolates sessions between browser clients. */
  clientId: string
}

/** One failed login with a safe message for the panel. */
export class ExternalLoginError extends Error {
  constructor(
    readonly code: ExternalLoginErrorCode,
    message: string,
    readonly headedAvailable = false,
    readonly hint = '',
  ) {
    super(message)
    this.name = 'ExternalLoginError'
  }
}

/** Logging surface used by the broker. */
export interface ExternalBrokerLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

/** Broker sizing and launch seams. */
export interface ExternalBrokerOptions {
  /** Session lifetime in milliseconds. */
  ttlMs: number
  /** Maximum retained sessions; the oldest is evicted first. */
  maxSessions: number
  /** Overall budget for one recipe across all steps. */
  overallTimeoutMs: number
  /** Headed launches require this flag and an explicit `mode: 'headed'` request. */
  headedEnabled: boolean
  /** Playwright browser channel, passed through when non-empty. */
  browserChannel?: string
  logger: ExternalBrokerLogger
  /** Clock seam for TTL tests. */
  now?: () => number
  /** Browser launch seam for tests; production loads Playwright lazily. */
  launch?: (options: { headless: boolean; channel?: string }) => Promise<PlaywrightBrowser>
}

interface BrokerSession {
  id: string
  cockpitId: string
  clientId: string
  credentialId: string | null
  credentialName: string | null
  mode: 'headless' | 'headed'
  /** Serialized Playwright storageState; process memory only. */
  storageState: string
  /** PNG bytes shown to the panel; process memory only. */
  screenshot: Buffer
  finalOrigin: string
  createdAt: number
  expiresAt: number
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u
const STORAGE_STATE_MAX_BYTES = 4 * 1024 * 1024
const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024
const BODY_TEXT_LIMIT = 8_000

/** Load Playwright lazily so the plugin still loads without a browser package. */
const loadPlaywright = async (): Promise<PlaywrightModule> => {
  for (const name of ['playwright', 'playwright-core']) {
    try {
      const loaded = await import(name) as { chromium?: PlaywrightModule['chromium'] }
      if (loaded.chromium !== undefined) return loaded as PlaywrightModule
    } catch {
      // Try the next package; the final miss becomes BROWSER_UNAVAILABLE.
    }
  }
  throw new ExternalLoginError(
    'BROWSER_UNAVAILABLE',
    'Host 未安装 Playwright，无法执行外部驾驶舱登录',
    false,
    '在有头/无头依赖环境中安装 playwright（或 playwright-core）后重启 DSH。',
  )
}

/** Production launcher. */
const launchPlaywrightBrowser = async (options: { headless: boolean; channel?: string }): Promise<PlaywrightBrowser> => {
  const playwright = await loadPlaywright()
  return playwright.chromium.launch({
    headless: options.headless,
    ...(options.channel === undefined || options.channel === '' ? {} : { channel: options.channel }),
  })
}

/** Map a recipe placeholder to the one value the broker resolved. */
const credentialValues = (input: ExternalLoginInput): Record<ExternalRecipePlaceholder, string> => ({
  url: input.cockpit.url ?? '',
  username: input.credential.username ?? input.credential.secret.username ?? '',
  password: input.credential.secret.password ?? '',
  token: input.credential.secret.token ?? '',
  secret: input.credential.secret.secret ?? '',
  secondary: input.credential.secret.secondary ?? '',
})

/** Resolve every template before launch so a missing field fails without a browser. */
const assertRecipeValues = (recipe: ExternalLoginRecipe, values: Record<ExternalRecipePlaceholder, string>): void => {
  try {
    for (const step of recipe.steps) {
      if (step.action === 'goto') resolveExternalRecipeTemplate(step.url, values)
      if (step.action === 'fill') resolveExternalRecipeTemplate(step.value, values)
    }
  } catch (error) {
    throw new ExternalLoginError(
      'SECRET_MISSING',
      error instanceof Error ? error.message : '登录 recipe 需要的凭据字段为空',
      false,
      '在「凭据」页补全该凭据的用户名/密码或令牌后重试。',
    )
  }
}

/** Heuristic challenge detection after a failed step. */
const detectChallenge = async (page: PlaywrightPage): Promise<'MFA_REQUIRED' | 'CAPTCHA_REQUIRED' | null> => {
  const current = page.url()
  if (/captcha|geetest|hcaptcha|recaptcha/iu.test(current)) return 'CAPTCHA_REQUIRED'
  if (/mfa|otp|2fa|two-factor|verify|challenge/iu.test(current)) return 'MFA_REQUIRED'
  let text = ''
  try {
    text = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 8000))
  } catch {
    return null
  }
  const visible = text.slice(0, BODY_TEXT_LIMIT)
  if (/captcha|图形验证码|人机验证|滑动验证|安全校验/iu.test(visible)) return 'CAPTCHA_REQUIRED'
  if (/mfa|otp|2fa|two-factor|authenticator|动态码|短信验证码|验证码/iu.test(visible)) return 'MFA_REQUIRED'
  return null
}

/** External cockpit login session broker. */
export class ExternalLoginBroker {
  private readonly sessions = new Map<string, BrokerSession>()
  private readonly now: () => number
  private readonly launch: (options: { headless: boolean; channel?: string }) => Promise<PlaywrightBrowser>

  constructor(private readonly options: ExternalBrokerOptions) {
    this.now = options.now ?? (() => Date.now())
    this.launch = options.launch ?? launchPlaywrightBrowser
  }

  private key(cockpitId: string, sessionId: string): string {
    return cockpitId + ':' + sessionId
  }

  /** Drop expired sessions; called on every create/read. */
  private purge(): void {
    const now = this.now()
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key)
    }
  }

  /** Evict the oldest sessions until one more fits. */
  private trim(): void {
    const limit = Math.max(1, Math.trunc(this.options.maxSessions))
    while (this.sessions.size >= limit) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, session] of this.sessions) {
        if (session.createdAt < oldestAt) {
          oldestAt = session.createdAt
          oldestKey = key
        }
      }
      if (oldestKey === undefined) return
      this.sessions.delete(oldestKey)
    }
  }

  private audit(outcome: {
    cockpitId: string
    credentialId: string | null
    mode: 'headless' | 'headed'
    ok: boolean
    code?: ExternalLoginErrorCode
    durationMs: number
  }): void {
    try {
      const line = '[audit] dsh-artifact-app external_login ' + JSON.stringify(outcome)
      if (outcome.ok) this.options.logger.info(line)
      else this.options.logger.warn(line)
    } catch {
      // Auditing must never change the login outcome.
    }
  }

  /**
   * Run one login recipe in an isolated browser context.
   * @param input - cockpit, recipe, matched credential and explicit mode.
   * @returns A public session view; storage state and screenshot stay in memory.
   */
  async login(input: ExternalLoginInput): Promise<ExternalLoginSessionView> {
    const started = this.now()
    let page: PlaywrightPage | undefined
    let browser: PlaywrightBrowser | undefined
    try {
      const url = input.cockpit.url
      if (url === null || !externalNavigationAllowed(url, input.allowedOrigins)) {
        throw new ExternalLoginError('NAVIGATION_BLOCKED', '外部驾驶舱 URL 不在 HTTPS allowlist 内')
      }
      if (input.mode === 'headed' && !this.options.headedEnabled) {
        throw new ExternalLoginError(
          'HEADED_DISABLED',
          '当前部署未启用有头浏览器',
          false,
          '由部署管理员设置 externalHeadedEnabled: true 后再试；MFA/验证码可在有头模式人工接管。',
        )
      }
      if (input.recipe.timeoutMs > this.options.overallTimeoutMs) {
        // The deployment budget is the hard ceiling; a larger recipe is a config error.
        throw new ExternalLoginError('RECIPE_INVALID', '登录 recipe 的 timeoutMs 超过部署上限')
      }
      const values = credentialValues(input)
      assertRecipeValues(input.recipe, values)
      // Validate every literal/template navigation before a browser process starts.
      for (const step of input.recipe.steps) {
        if (step.action !== 'goto') continue
        assertExternalNavigation(resolveExternalRecipeTemplate(step.url, values), input.allowedOrigins)
      }

      const deadline = started + Math.max(1_000, Math.min(input.recipe.timeoutMs, this.options.overallTimeoutMs))
      const remaining = (): number => {
        const left = deadline - this.now()
        if (left < 1) throw new ExternalLoginError('TIMEOUT', '登录超时，未在限定时间内完成', false, '检查目标站点是否可达，或提高 externalLoginTimeoutMs。')
        return left
      }

      browser = await this.launch({
        headless: input.mode === 'headless',
        ...(this.options.browserChannel === undefined || this.options.browserChannel === '' ? {} : { channel: this.options.browserChannel }),
      })
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        locale: 'zh-CN',
        ignoreHTTPSErrors: false,
        serviceWorkers: 'block',
      })
      try {
        page = await context.newPage()
        await page.route('**/*', async (route) => {
          const request = route.request()
          const target = request.url()
          if (!externalSubresourceAllowed(target)) {
            await route.abort('blockedbyclient')
            return
          }
          if (request.isNavigationRequest() && request.frame() === page?.mainFrame()
            && !externalNavigationAllowed(target, input.allowedOrigins)) {
            await route.abort('blockedbyclient')
            return
          }
          await route.continue()
        })

        for (const step of input.recipe.steps) {
          switch (step.action) {
            case 'goto': {
              const target = resolveExternalRecipeTemplate(step.url, values)
              assertExternalNavigation(target, input.allowedOrigins)
              await page.goto(target, { waitUntil: 'domcontentloaded', timeout: remaining() })
              break
            }
            case 'fill': {
              const value = resolveExternalRecipeTemplate(step.value, values)
              await page.fill(step.selector, value, { timeout: remaining() })
              break
            }
            case 'click':
              await page.click(step.selector, { timeout: remaining() })
              break
            case 'waitForSelector':
              await page.waitForSelector(step.selector, { timeout: remaining(), state: 'visible' })
              break
            case 'waitForURL':
              await page.waitForURL(step.pattern, { timeout: remaining() })
              break
            case 'wait':
              await page.waitForTimeout(Math.min(step.ms, remaining()))
              break
          }
        }

        if (input.recipe.success.selector !== undefined) {
          await page.waitForSelector(input.recipe.success.selector, { timeout: remaining(), state: 'visible' })
        }
        if (input.recipe.success.url !== undefined) {
          await page.waitForURL(input.recipe.success.url, { timeout: remaining() })
        }
        const finalUrl = page.url()
        assertExternalNavigation(finalUrl, input.allowedOrigins)

        const screenshot = await page.screenshot({ type: 'png', fullPage: false })
        if (screenshot.byteLength > SCREENSHOT_MAX_BYTES) {
          throw new ExternalLoginError('LOGIN_FAILED', '登录后截图超过大小上限')
        }
        const storageState = JSON.stringify(await context.storageState())
        if (Buffer.byteLength(storageState, 'utf8') > STORAGE_STATE_MAX_BYTES) {
          throw new ExternalLoginError('LOGIN_FAILED', '登录状态超过大小上限')
        }

        this.purge()
        this.trim()
        const sessionId = randomBytes(24).toString('base64url')
        const createdAt = this.now()
        const expiresAt = createdAt + Math.max(1_000, this.options.ttlMs)
        const finalOrigin = new URL(finalUrl).origin
        this.sessions.set(this.key(input.cockpit.id, sessionId), {
          id: sessionId,
          cockpitId: input.cockpit.id,
          clientId: input.clientId,
          credentialId: input.credential.id,
          credentialName: input.credential.name,
          mode: input.mode,
          storageState,
          screenshot,
          finalOrigin,
          createdAt,
          expiresAt,
        })

        this.audit({
          cockpitId: input.cockpit.id,
          credentialId: input.credential.id,
          mode: input.mode,
          ok: true,
          durationMs: this.now() - started,
        })

        return {
          ok: true,
          sessionId,
          cockpitId: input.cockpit.id,
          cockpitName: input.cockpit.name,
          credentialId: input.credential.id,
          credentialName: input.credential.name,
          mode: input.mode,
          screenshotUrl: EXTERNAL_COCKPITS_PATH + '/' + encodeURIComponent(input.cockpit.id)
            + '/sessions/' + sessionId + '/screenshot?client=' + encodeURIComponent(input.clientId),
          finalOrigin,
          expiresAt: new Date(expiresAt).toISOString(),
        }
      } finally {
        await context.close().catch(() => undefined)
      }
    } catch (error) {
      const mapped = await this.mapLoginError(error, page, input)
      this.audit({
        cockpitId: input.cockpit.id,
        credentialId: input.credential.id,
        mode: input.mode,
        ok: false,
        code: mapped.code,
        durationMs: this.now() - started,
      })
      throw mapped
    } finally {
      await browser?.close().catch(() => undefined)
    }
  }

  /** Translate broker, Playwright and security failures into safe user-facing errors. */
  private async mapLoginError(
    error: unknown,
    page: PlaywrightPage | undefined,
    input: ExternalLoginInput,
  ): Promise<ExternalLoginError> {
    const headedAvailable = input.mode === 'headless' && this.options.headedEnabled
    if (error instanceof ExternalLoginError) {
      return new ExternalLoginError(error.code, error.message, error.headedAvailable || headedAvailable, error.hint)
    }
    if (error instanceof ExternalCockpitSecurityError) {
      return new ExternalLoginError(error.code, error.message, headedAvailable)
    }
    const rawMessage = error instanceof Error ? error.message : ''
    if (/ERR_BLOCKED_BY_CLIENT|blockedbyclient/iu.test(rawMessage)) {
      return new ExternalLoginError('NAVIGATION_BLOCKED', '登录流程的请求被 allowlist 拦截', headedAvailable)
    }
    if (page !== undefined) {
      const challenge = await detectChallenge(page)
      if (challenge === 'CAPTCHA_REQUIRED') {
        return new ExternalLoginError(
          'CAPTCHA_REQUIRED',
          '目标站点要求验证码或人机校验',
          headedAvailable,
          headedAvailable ? '勾选有头模式后重试，并在浏览器窗口中人工完成校验。' : '需要部署启用有头模式后人工接管。',
        )
      }
      if (challenge === 'MFA_REQUIRED') {
        return new ExternalLoginError(
          'MFA_REQUIRED',
          '目标站点要求多因素认证（MFA/短信/动态码）',
          headedAvailable,
          headedAvailable ? '勾选有头模式后重试，并在浏览器窗口中完成 MFA。' : '需要部署启用有头模式后人工接管。',
        )
      }
      if (!externalNavigationAllowed(page.url(), input.allowedOrigins)) {
        return new ExternalLoginError('NAVIGATION_BLOCKED', '登录流程跳转到了不在 allowlist 内的地址', headedAvailable)
      }
    }
    const name = error instanceof Error ? error.name : ''
    if (/timeout/iu.test(name)) {
      return new ExternalLoginError('TIMEOUT', '登录超时，未在限定时间内完成', headedAvailable)
    }
    return new ExternalLoginError(
      'LOGIN_FAILED',
      '登录失败，请检查 recipe 选择器与凭据后重试',
      headedAvailable,
      headedAvailable ? '可勾选有头模式观察登录过程；MFA/验证码场景需要人工接管。' : '',
    )
  }

  /** Read one live session and prove the caller owns it. */
  private take(cockpitId: string, sessionId: string, clientId: string): BrokerSession {
    this.purge()
    if (!SESSION_ID_PATTERN.test(sessionId)) throw new ExternalLoginError('LOGIN_FAILED', '登录会话 id 非法')
    const session = this.sessions.get(this.key(cockpitId, sessionId))
    if (session === undefined || session.clientId !== clientId) {
      throw new ExternalLoginError('LOGIN_FAILED', '登录会话不存在或已过期')
    }
    return session
  }

  /**
   * Return the screenshot for one live session.
   * @param cockpitId - registry id the session belongs to.
   * @param sessionId - opaque session id.
   * @param clientId - browser-session id that created the session.
   * @returns PNG bytes.
   */
  screenshot(cockpitId: string, sessionId: string, clientId: string): Buffer {
    return this.take(cockpitId, sessionId, clientId).screenshot
  }

  /**
   * End one session and drop its storage state and screenshot.
   * @param cockpitId - registry id.
   * @param sessionId - opaque session id.
   * @param clientId - browser-session id that created the session.
   */
  end(cockpitId: string, sessionId: string, clientId: string): void {
    this.take(cockpitId, sessionId, clientId)
    this.sessions.delete(this.key(cockpitId, sessionId))
  }

  /** Drop every session; called when the plugin unloads. */
  dispose(): void {
    this.sessions.clear()
  }

  /** Live session count; used by tests and diagnostics. */
  get size(): number {
    this.purge()
    return this.sessions.size
  }
}