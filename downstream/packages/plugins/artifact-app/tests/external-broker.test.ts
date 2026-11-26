import { describe, expect, it, vi } from 'vitest'
import {
  externalNavigationAllowed,
  externalSubresourceAllowed,
  normalizeExternalLoginRecipe,
  type ExternalCockpitRow,
} from '../src/external.ts'
import { ExternalLoginBroker, ExternalLoginError, type ExternalLoginInput } from '../src/external-broker.ts'

const cockpit: ExternalCockpitRow = {
  id: 'ext-1',
  name: '销售驾驶舱',
  description: null,
  url: 'https://cockpit.example/sales',
  icon: null,
  tags: [],
  ownerId: null,
  visibility: 'PRIVATE',
  credentialType: 'http',
  credentialHint: null,
  enabled: true,
  health: null,
  updatedAt: null,
}

const recipe = normalizeExternalLoginRecipe({
  version: 1,
  steps: [
    { action: 'goto', url: '{{url}}' },
    { action: 'fill', selector: 'input[name=username]', value: '{{username}}' },
    { action: 'fill', selector: 'input[type=password]', value: '{{password}}' },
    { action: 'click', selector: 'button[type=submit]' },
    { action: 'waitForURL', pattern: '**/dashboard' },
  ],
  success: { selector: '[data-cockpit-ready]' },
  timeoutMs: 10_000,
})!

interface FakeBehaviour {
  failOn?: 'goto' | 'fill' | 'click'
  bodyText?: string
}

function fakeBrowser(behaviour: FakeBehaviour = {}) {
  const calls: Array<{ kind: string; args: unknown[] }> = []
  const frame = {}
  const page = {
    current: 'https://cockpit.example/sales',
    url() { return this.current },
    async goto(url: string) {
      calls.push({ kind: 'goto', args: [url] })
      if (behaviour.failOn === 'goto') throw Object.assign(new Error('goto timeout'), { name: 'TimeoutError' })
      this.current = url
    },
    async fill(selector: string, value: string) {
      calls.push({ kind: 'fill', args: [selector, value] })
      if (behaviour.failOn === 'fill') throw new Error('fill failed')
    },
    async click(selector: string) {
      calls.push({ kind: 'click', args: [selector] })
      if (behaviour.failOn === 'click') throw new Error('click failed')
    },
    async waitForSelector(selector: string) { calls.push({ kind: 'waitForSelector', args: [selector] }) },
    async waitForURL(pattern: string) {
      calls.push({ kind: 'waitForURL', args: [pattern] })
      this.current = 'https://cockpit.example/dashboard'
    },
    async waitForTimeout(ms: number) { calls.push({ kind: 'waitForTimeout', args: [ms] }) },
    async screenshot(options: unknown) {
      calls.push({ kind: 'screenshot', args: [options] })
      return Buffer.from('png-bytes')
    },
    async evaluate<T>(fn: () => T): Promise<T> {
      return (behaviour.bodyText ?? '') as unknown as T
    },
    mainFrame() { return frame },
    async route(pattern: string, handler: unknown) { calls.push({ kind: 'route', args: [pattern, handler] }) },
  }
  const contexts: Array<{ options: Record<string, unknown> }> = []
  const context = {
    async newPage() { return page },
    async storageState() { return { cookies: [{ name: 'sid', value: 'cookie-secret' }], origins: [] } },
    async close() { calls.push({ kind: 'context.close', args: [] }) },
  }
  const browser = {
    async newContext(options: Record<string, unknown>) {
      contexts.push({ options })
      return context
    },
    async close() { calls.push({ kind: 'browser.close', args: [] }) },
  }
  return { browser, calls, contexts, page }
}

function fixture(behaviour: FakeBehaviour = {}, options: { headedEnabled?: boolean; ttlMs?: number } = {}) {
  const fake = fakeBrowser(behaviour)
  const launches: Array<{ headless: boolean }> = []
  let now = 1_000
  const broker = new ExternalLoginBroker({
    ttlMs: options.ttlMs ?? 60_000,
    maxSessions: 2,
    overallTimeoutMs: 30_000,
    headedEnabled: options.headedEnabled ?? true,
    now: () => now,
    launch: async (launchOptions) => {
      launches.push(launchOptions)
      return fake.browser as never
    },
    logger: { info: vi.fn(), warn: vi.fn() },
  })
  const input = (overrides: Partial<ExternalLoginInput> = {}): ExternalLoginInput => ({
    cockpit,
    recipe,
    allowedOrigins: ['https://cockpit.example'],
    credential: {
      id: 'cred-1',
      name: 'CRM 登录',
      username: 'alice',
      secret: { password: 'pw-secret', token: 'token-secret' },
    },
    mode: 'headless',
    clientId: 'client-abcdefgh',
    ...overrides,
  })
  return { broker, fake, launches, input, tick: (ms: number) => { now += ms } }
}

describe('external login broker', () => {
  it('runs recipes headless by default, interpolates secrets and returns no secret material', async () => {
    const { broker, fake, launches, input } = fixture()
    const result = await broker.login(input())

    expect(launches).toEqual([{ headless: true }])
    expect(fake.calls.filter((call) => call.kind === 'fill')).toEqual([
      { kind: 'fill', args: ['input[name=username]', 'alice'] },
      { kind: 'fill', args: ['input[type=password]', 'pw-secret'] },
    ])
    expect(fake.calls.some((call) => call.kind === 'goto' && call.args[0] === 'https://cockpit.example/sales')).toBe(true)
    expect(fake.calls.some((call) => call.kind === 'waitForURL' && call.args[0] === '**/dashboard')).toBe(true)
    expect(result).toMatchObject({
      ok: true,
      cockpitId: 'ext-1',
      credentialId: 'cred-1',
      credentialName: 'CRM 登录',
      mode: 'headless',
      finalOrigin: 'https://cockpit.example',
    })
    expect(result.screenshotUrl).toContain('/external-cockpits/ext-1/sessions/')
    expect(JSON.stringify(result)).not.toContain('pw-secret')
    expect(JSON.stringify(result)).not.toContain('token-secret')
    expect(JSON.stringify(result)).not.toContain('cookie-secret')
    expect(JSON.stringify(result)).not.toContain('storageState')

    expect(broker.screenshot('ext-1', result.sessionId, 'client-abcdefgh').toString()).toBe('png-bytes')
    expect(broker.size).toBe(1)
  })

  it('launches headed only when the request says headed', async () => {
    const { broker, launches, input } = fixture()
    await broker.login(input({ mode: 'headed' }))
    expect(launches).toEqual([{ headless: false }])
  })

  it('refuses headed mode when the deployment disables it', async () => {
    const { broker, launches, input } = fixture({}, { headedEnabled: false })
    await expect(broker.login(input({ mode: 'headed' }))).rejects.toMatchObject({ code: 'HEADED_DISABLED' })
    expect(launches).toHaveLength(0)
  })

  it('fails before launch when a recipe needs a missing secret', async () => {
    const { broker, launches, input } = fixture()
    await expect(broker.login(input({
      credential: { id: 'cred-1', name: 'CRM', username: 'alice', secret: {} },
    }))).rejects.toMatchObject({ code: 'SECRET_MISSING' })
    expect(launches).toHaveLength(0)
  })

  it('rejects a recipe navigation outside the allowlist before launch', async () => {
    const { broker, launches, input } = fixture()
    const evil = normalizeExternalLoginRecipe({
      version: 1,
      steps: [{ action: 'goto', url: 'https://evil.example/login' }],
      timeoutMs: 5_000,
    })!
    await expect(broker.login(input({ recipe: evil }))).rejects.toMatchObject({ code: 'NAVIGATION_BLOCKED' })
    expect(launches).toHaveLength(0)
  })

  it('reports MFA with a headed takeover hint instead of leaking page text', async () => {
    const { broker, input } = fixture({ failOn: 'fill', bodyText: '请输入短信验证码完成登录' })
    await expect(broker.login(input())).rejects.toMatchObject({
      code: 'MFA_REQUIRED',
      headedAvailable: true,
      hint: expect.stringContaining('有头模式'),
    })
  })

  it('expires sessions and binds them to the creating browser client', async () => {
    const { broker, input, tick } = fixture({}, { ttlMs: 5_000 })
    const result = await broker.login(input())
    expect(() => broker.screenshot('ext-1', result.sessionId, 'other-client-1')).toThrow(ExternalLoginError)
    tick(5_001)
    expect(() => broker.screenshot('ext-1', result.sessionId, 'client-abcdefgh')).toThrow(/过期/)
  })

  it('evicts the oldest session when the cap is reached', async () => {
    const { broker, input } = fixture()
    const first = await broker.login(input())
    const second = await broker.login(input())
    const third = await broker.login(input())
    expect(broker.size).toBe(2)
    expect(() => broker.screenshot('ext-1', first.sessionId, 'client-abcdefgh')).toThrow(/过期|不存在/)
    expect(broker.screenshot('ext-1', second.sessionId, 'client-abcdefgh')).toBeTruthy()
    expect(broker.screenshot('ext-1', third.sessionId, 'client-abcdefgh')).toBeTruthy()
  })
})

describe('external login URL policy', () => {
  it('allows HTTPS subresources on public hosts only', () => {
    expect(externalSubresourceAllowed('https://cdn.example.com/app.js')).toBe(true)
    expect(externalSubresourceAllowed('data:text/css,body{}')).toBe(true)
    expect(externalSubresourceAllowed('http://cdn.example.com/app.js')).toBe(false)
    expect(externalSubresourceAllowed('https://127.0.0.1/admin')).toBe(false)
    expect(externalSubresourceAllowed('https://169.254.169.254/latest/meta-data')).toBe(false)
    expect(externalSubresourceAllowed('https://metadata.google.internal/')).toBe(false)
    expect(externalSubresourceAllowed('https://localhost./admin')).toBe(false)
    expect(externalSubresourceAllowed('https://0x7f000001/admin')).toBe(false)
    expect(externalSubresourceAllowed('https://[::ffff:127.0.0.1]/admin')).toBe(false)
  })

  it('requires top-level navigation to stay on allowlisted HTTPS origins', () => {
    const allowed = ['https://cockpit.example']
    expect(externalNavigationAllowed('https://cockpit.example/dashboard', allowed)).toBe(true)
    expect(externalNavigationAllowed('https://cockpit.example.evil.com/', allowed)).toBe(false)
    expect(externalNavigationAllowed('http://cockpit.example/', allowed)).toBe(false)
    expect(externalNavigationAllowed('https://evil.example/', allowed)).toBe(false)
  })
})