// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExternalCockpitPanel, type ExternalCockpitItem } from '../src/client/ExternalCockpitPanel.tsx'

const sales: ExternalCockpitItem = {
  id: 'ext-1',
  name: '销售驾驶舱',
  description: '外部销售分析',
  url: 'https://cockpit.example/sales',
  icon: null,
  tags: ['sales', 'crm'],
  ownerId: 'user-1',
  visibility: 'DEPARTMENT',
  credentialType: 'http',
  credentialHint: '域账号',
  enabled: true,
  health: 'ok',
  updatedAt: '2026-11-26T10:00:00.000Z',
}

const finance: ExternalCockpitItem = {
  ...sales,
  id: 'ext-2',
  name: '财务驾驶舱',
  description: '外部财务分析',
  tags: ['finance'],
}

const jsonResponse = (value: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
} as Response)

const fetchMock = (handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) => {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    return await handler(url, init)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('external cockpit panel', () => {
  it('renders registry rows and their metadata', async () => {
    fetchMock(async (url) => {
      expect(url.pathname).toBe('/dsh-artifact-app/external-cockpits')
      expect(url.searchParams.get('pageSize')).toBe('50')
      return jsonResponse({ items: [sales], total: 1, page: 1, pageSize: 50 })
    })
    render(<ExternalCockpitPanel />)
    expect(await screen.findByText('销售驾驶舱')).toBeTruthy()
    expect(screen.getByText('外部销售分析')).toBeTruthy()
    expect(screen.getByText('sales')).toBeTruthy()
    expect(screen.getByText('部门可见')).toBeTruthy()
    expect(screen.getByText('共 1 个外部驾驶舱')).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '复制链接' })).toBeTruthy()
  })

  it('searches with the submitted keyword', async () => {
    const mock = fetchMock(async (url) => {
      const search = url.searchParams.get('search')
      const items = search === '财务' ? [finance] : [sales]
      return jsonResponse({ items, total: items.length })
    })
    render(<ExternalCockpitPanel />)
    await screen.findByText('销售驾驶舱')

    fireEvent.change(screen.getByLabelText('搜索外部驾驶舱'), { target: { value: '财务' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(await screen.findByText('财务驾驶舱')).toBeTruthy()
    expect(mock.mock.calls.some(([input]) => String(input).includes('search=%E8%B4%A2%E5%8A%A1'))).toBe(true)
  })

  it('shows the empty state', async () => {
    fetchMock(async () => jsonResponse({ items: [], total: 0 }))
    render(<ExternalCockpitPanel />)
    expect(await screen.findByText(/暂无外部驾驶舱/)).toBeTruthy()
    expect(screen.getByText(/请先在 DataOps 门户登记/)).toBeTruthy()
  })

  it('shows an error with retry, then recovers', async () => {
    let calls = 0
    fetchMock(async () => {
      calls += 1
      if (calls === 1) return jsonResponse({ error: '注册表暂不可用' }, 503)
      return jsonResponse({ items: [sales], total: 1 })
    })
    render(<ExternalCockpitPanel />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('注册表暂不可用')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('销售驾驶舱')).toBeTruthy()
  })

  it('opens the stable link in a new window', async () => {
    fetchMock(async (url, init) => {
      if (url.pathname.endsWith('/link')) {
        expect(init?.method).toBe('POST')
        return jsonResponse({ id: 'ext-1', url: 'https://cockpit.example/sales' })
      }
      return jsonResponse({ items: [sales], total: 1 })
    })
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    render(<ExternalCockpitPanel />)
    await screen.findByText('销售驾驶舱')

    fireEvent.click(screen.getByRole('button', { name: '打开' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith(
      'https://cockpit.example/sales',
      '_blank',
      'noopener,noreferrer',
    ))
  })

  it('copies the stable link', async () => {
    fetchMock(async (url) => {
      if (url.pathname.endsWith('/link')) return jsonResponse({ id: 'ext-1', url: 'https://cockpit.example/sales' })
      return jsonResponse({ items: [sales], total: 1 })
    })
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<ExternalCockpitPanel />)
    await screen.findByText('销售驾驶舱')

    fireEvent.click(screen.getByRole('button', { name: '复制链接' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://cockpit.example/sales'))
  })

  it('renders the manual fallback link alongside the new window', async () => {
    fetchMock(async (url) => {
      if (url.pathname.endsWith('/link')) return jsonResponse({ id: 'ext-1', url: 'https://cockpit.example/sales' })
      return jsonResponse({ items: [sales], total: 1 })
    })
    vi.spyOn(window, 'open').mockReturnValue({} as Window)
    render(<ExternalCockpitPanel />)
    await screen.findByText('销售驾驶舱')

    fireEvent.click(screen.getByRole('button', { name: '打开' }))
    const link = await screen.findByRole('link', { name: /手动打开/ })
    expect(link.getAttribute('href')).toBe('https://cockpit.example/sales')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('selects a site credential, logs in headlessly and shows the screenshot', async () => {
    const loginBodies: string[] = []
    fetchMock(async (url, init) => {
      if (url.pathname === '/dsh-artifact-app/external-cockpits') {
        return jsonResponse({ items: [sales], total: 1 })
      }
      if (url.pathname.endsWith('/ext-1/credentials')) {
        return jsonResponse({
          cockpitId: 'ext-1',
          credentialType: 'http',
          siteOrigin: 'https://cockpit.example',
          credentialServiceAvailable: true,
          recipeAvailable: true,
          recipeError: null,
          headedEnabled: true,
          credentials: [{
            id: 'cred-1',
            name: 'CRM 登录',
            type: 'http',
            authKind: 'basic',
            username: 'alice',
            origin: 'https://cockpit.example',
            tags: [],
            secretConfigured: true,
          }],
        })
      }
      if (url.pathname.endsWith('/ext-1/login')) {
        loginBodies.push(String(init?.body ?? ''))
        return jsonResponse({
          ok: true,
          sessionId: 'session-1234567890',
          cockpitId: 'ext-1',
          cockpitName: '销售驾驶舱',
          credentialId: 'cred-1',
          credentialName: 'CRM 登录',
          mode: 'headless',
          screenshotUrl: '/dsh-artifact-app/external-cockpits/ext-1/sessions/session-1234567890/screenshot?client=x',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          stableUrl: 'https://cockpit.example/sales',
        })
      }
      throw new Error('unexpected ' + url.pathname)
    })

    render(<ExternalCockpitPanel />)
    await screen.findByText('销售驾驶舱')
    fireEvent.click(screen.getByRole('button', { name: '登录并截图' }))
    expect(await screen.findByText('CRM 登录')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '无头登录' }))

    expect(await screen.findByText('已登录：销售驾驶舱')).toBeTruthy()
    expect(screen.getByAltText('登录后的页面截图：销售驾驶舱')).toBeTruthy()
    expect(screen.getByRole('link', { name: '打开原站' }).getAttribute('href')).toBe('https://cockpit.example/sales')
    const body = JSON.parse(loginBodies[0] ?? '{}') as Record<string, unknown>
    expect(body).toMatchObject({ credentialId: 'cred-1', mode: 'headless' })
    expect(loginBodies[0]).not.toContain('password')
  })

  it('shows an MFA failure and retries with explicit headed mode', async () => {
    const modes: string[] = []
    fetchMock(async (url, init) => {
      if (url.pathname === '/dsh-artifact-app/external-cockpits') {
        return jsonResponse({ items: [sales], total: 1 })
      }
      if (url.pathname.endsWith('/ext-1/credentials')) {
        return jsonResponse({
          credentials: [{
            id: 'cred-1',
            name: 'CRM 登录',
            type: 'http',
            authKind: 'basic',
            username: 'alice',
            origin: 'https://cockpit.example',
            tags: [],
            secretConfigured: true,
          }],
          credentialServiceAvailable: true,
          recipeAvailable: true,
          headedEnabled: true,
        })
      }
      if (url.pathname.endsWith('/ext-1/login')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { mode?: string }
        modes.push(body.mode ?? '')
        if (modes.length === 1) {
          return jsonResponse({
            ok: false,
            code: 'MFA_REQUIRED',
            message: '目标站点要求多因素认证（MFA/短信/动态码）',
            hint: '勾选有头模式后重试，并在浏览器窗口中完成 MFA。',
            headedAvailable: true,
          }, 409)
        }
        return jsonResponse({
          ok: true,
          sessionId: 'session-1234567890',
          screenshotUrl: '/shot.png',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          mode: 'headed',
        })
      }
      throw new Error('unexpected ' + url.pathname)
    })

    render(<ExternalCockpitPanel />)
    await screen.findByText('销售驾驶舱')
    fireEvent.click(screen.getByRole('button', { name: '登录并截图' }))
    await screen.findByText('CRM 登录')
    fireEvent.click(screen.getByRole('button', { name: '无头登录' }))
    expect(await screen.findByText(/MFA_REQUIRED/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '改用有头模式重试' }))
    await waitFor(() => expect(modes).toEqual(['headless', 'headed']))
    expect(await screen.findByText('已登录：销售驾驶舱')).toBeTruthy()
  })
})
