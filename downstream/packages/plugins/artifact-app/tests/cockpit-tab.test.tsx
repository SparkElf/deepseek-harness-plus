// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CockpitTab } from '../src/client/CockpitTab.tsx'

const jsonResponse = (value: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
} as Response)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('cockpit tab', () => {
  it('keeps internal assets and adds the external cockpit tab', () => {
    const html = renderToStaticMarkup(<CockpitTab tab={{}} />)
    expect(html).toContain('内部资产')
    expect(html).toContain('外部驾驶舱')
    expect(html).toContain('正在加载驾驶舱资产')
    expect(html).not.toContain('<iframe')
  })

  it('switches to the external registry pane', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/dsh-artifact-app/apps') return jsonResponse({ items: [], total: 0 })
      if (url.pathname === '/dsh-artifact-app/templates') return jsonResponse({ items: [] })
      if (url.pathname === '/dsh-artifact-app/external-cockpits') {
        return jsonResponse({
          items: [{
            id: 'ext-1',
            name: '外部销售驾驶舱',
            description: '外部销售分析',
            url: 'https://cockpit.example/sales',
            icon: null,
            tags: ['sales'],
            ownerId: null,
            visibility: 'ALL',
            credentialType: 'none',
            credentialHint: null,
            enabled: true,
            health: null,
            updatedAt: null,
          }],
          total: 1,
        })
      }
      throw new Error('unexpected fetch ' + url.pathname)
    }))

    render(<CockpitTab tab={{}} />)
    fireEvent.click(screen.getByRole('tab', { name: '外部驾驶舱' }))
    expect(await screen.findByText('外部销售驾驶舱')).toBeTruthy()
    expect(screen.getByText(/M2：按站点 origin 列出匹配凭据/)).toBeTruthy()
  })

  it('wraps card actions in a 360-420px sidebar without hardcoded colors', () => {
    const html = renderToStaticMarkup(<CockpitTab tab={{}} />)
    expect(html).toContain('@media (max-width: 420px)')
    expect(html).toContain('.dsh-ac__actions .dsh-ac__btn { flex: 1 1 auto; }')
    expect(html).not.toMatch(/background:\s*#(?:fff|000)\b/iu)
  })
})