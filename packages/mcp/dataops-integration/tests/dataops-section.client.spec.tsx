// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataOpsSection, type DataOpsSectionInjected } from '../src/client/DataOpsSection.tsx'
import { en } from '../src/client/locales.ts'

const t: DataOpsSectionInjected['t'] = key => en[key]

const connectedStatus = {
  baseUrl: 'https://dataops.example.com',
  serverName: 'dataops',
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
  it('leads with connection and account identity while keeping transport details collapsed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => connectedStatus,
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    render(<DataOpsSection t={t} />)

    expect((await screen.findByText('Connected')).textContent).toBe('Connected')
    expect(screen.getByText('Harness can use DataOps with the permissions of this account.')).not.toBeNull()
    expect(screen.getByText('Alice Example')).not.toBeNull()
    expect(screen.getByText('alice@example.com')).not.toBeNull()
    expect(screen.getByText('alice')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Switch account' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Disconnect' })).not.toBeNull()

    const advancedSummary = screen.getByText('Advanced connection details')
    const advanced = advancedSummary.closest('details') as HTMLDetailsElement | null
    expect(advanced).not.toBeNull()
    expect(advanced?.open).toBe(false)
    expect(advanced?.textContent).toContain('https://dataops.example.com')
    expect(advanced?.textContent).toContain('DataOps account authorization')
    expect(fetchMock).toHaveBeenCalledWith('/integrations/dataops/status', { cache: 'no-store' })
  })

  it('offers the user-facing connect action before any transport terminology', async () => {
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
    expect(screen.getByText('Connect a DataOps account to use authenticated data access.')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Connect DataOps' })).not.toBeNull()
    expect(screen.queryByText('Alice Example')).toBeNull()
  })
})
