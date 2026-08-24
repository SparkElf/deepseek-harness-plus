// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataOpsSection, type DataOpsSectionInjected } from '../src/client/DataOpsSection.tsx'
import { en } from '../src/client/locales.ts'

const t: DataOpsSectionInjected['t'] = key => en[key]

const connectedStatus = {
  mode: 'oidc' as const,
  credentialConfigured: true,
  credentialWritable: true,
  authorizationAccepted: true,
  account: {
    username: 'alice',
    displayName: 'Alice Example',
    email: 'alice@example.com',
  },
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('DataOps settings section', () => {
  it('shows connection state, account identity, and account actions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => connectedStatus,
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    render(<DataOpsSection t={t} />)

    expect((await screen.findByText('Connected')).textContent).toBe('Connected')
    expect(screen.getByText('Alice Example')).not.toBeNull()
    expect(screen.getByText('alice@example.com')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Switch account' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Disconnect' })).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/integrations/dataops/status', { cache: 'no-store' })
  })

  it('offers the connect action when DataOps is not connected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...connectedStatus,
        credentialConfigured: false,
        authorizationAccepted: false,
        account: null,
      }),
    } as Response))

    render(<DataOpsSection t={t} />)

    expect((await screen.findByText('Not connected')).textContent).toBe('Not connected')
    expect(screen.getByRole('button', { name: 'Connect DataOps' })).not.toBeNull()
    expect(screen.queryByText('Alice Example')).toBeNull()
  })

  it('shows a short managed state without account actions when credentials are externally managed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...connectedStatus,
        credentialWritable: false,
        authorizationAccepted: false,
        account: null,
      }),
    } as Response))

    render(<DataOpsSection t={t} />)

    expect((await screen.findByText('Managed by administrator')).textContent).toBe('Managed by administrator')
    expect(screen.queryByRole('button', { name: 'Connect DataOps' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull()
  })

  it('keeps a failure state and retry action when the initial status read fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => connectedStatus,
      } as Response)
    vi.stubGlobal('fetch', fetchMock)

    render(<DataOpsSection t={t} />)

    expect((await screen.findByRole('alert')).textContent).toBe('Connection failed')
    expect(screen.queryByText('Not connected')).toBeNull()
    const retry = screen.getByRole('button', { name: 'Retry' })
    expect(retry).not.toBeNull()

    fireEvent.click(retry)

    expect((await screen.findByText('Connected')).textContent).toBe('Connected')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
