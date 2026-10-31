/**
 * Connector catalogue wire contract: parse a live answer, fall back to the demo
 * rows when the bridge has no route, and send the two writes the tab offers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConnectorRequestError,
  ConnectorUnavailableError,
  HttpConnectorSource,
  connectorState,
  parseConnectorList,
  readConnectorCatalogue,
  visibleCapabilities,
  type Connector,
} from '../src/client/connectors.ts'

const original = globalThis.fetch
afterEach(() => {
  globalThis.fetch = original
  vi.restoreAllMocks()
})

const wire = {
  connectors: [{
    id: 'wanxiang-ai',
    name: '万相AI中台连接器',
    vendor: 'DataOps',
    enabled: true,
    connected: true,
    capabilities: [
      { id: 'approval.read', name: '读取审批任务', enabled: true, permitted: true },
      { id: 'credential.manage', name: '管理连接凭据', enabled: false, permitted: false },
    ],
  }],
}

describe('catalogue parsing', () => {
  it('accepts the wrapped and bare list shapes and drops malformed rows', () => {
    expect(parseConnectorList(wire).map(connector => connector.id)).toEqual(['wanxiang-ai'])
    expect(parseConnectorList(wire.connectors).map(connector => connector.id)).toEqual(['wanxiang-ai'])
    expect(parseConnectorList({ connectors: [{ id: '', name: 'x' }, { id: 'ok', name: 'ok' }] }).map(connector => connector.id)).toEqual(['ok'])
    expect(parseConnectorList(null)).toEqual([])
  })

  it('keeps only capabilities the account may use', () => {
    const connector = parseConnectorList(wire)[0] as Connector
    expect(visibleCapabilities(connector).map(capability => capability.id)).toEqual(['approval.read'])
  })

  it('fills optional connector and capability fields and drops invalid rows', () => {
    const parsed = parseConnectorList({
      connectors: [
        null,
        { id: '', name: 'x' },
        { id: 'x', name: '' },
        {
          id: 'full', name: 'Full', vendor: 'V', description: 'D', enabled: true, connected: false, error: 'E',
          capabilities: [
            { id: 'bare' },
            { name: 'no-id' },
            { id: '', name: 'empty-id' },
            { id: 'rich', name: 'Rich', description: 'DC', enabled: true, permitted: false, unavailableReason: 'why' },
            'not-an-object',
          ],
        },
      ],
    })
    expect(parsed).toHaveLength(1)
    const connector = parsed[0] as Connector
    expect(connector).toMatchObject({
      id: 'full', vendor: 'V', description: 'D', connected: false, error: 'E',
    })
    expect(connector.capabilities).toEqual([
      { id: 'bare', name: 'bare', enabled: false, permitted: true },
      { id: 'rich', name: 'Rich', description: 'DC', enabled: true, permitted: false, unavailableReason: 'why' },
    ])
    expect(parseConnectorList({ connectors: 'nope' })).toEqual([])
    expect(parseConnectorList('nope')).toEqual([])
    expect(parseConnectorList([null, { id: 'x', name: 'x', capabilities: [] }])).toHaveLength(1)
  })

  it('classifies disabled, failing, and connected rows', () => {
    expect(connectorState({ id: 'x', name: 'x', enabled: false, capabilities: [] })).toBe('disabled')
    expect(connectorState({ id: 'x', name: 'x', enabled: true, connected: false, capabilities: [] })).toBe('error')
    expect(connectorState({ id: 'x', name: 'x', enabled: true, connected: true, capabilities: [] })).toBe('connected')
  })
})

describe('HttpConnectorSource', () => {
  it('reads the list and posts connector and capability writes', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(wire), { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const source = new HttpConnectorSource()
    await expect(source.list()).resolves.toHaveLength(1)
    await source.setEnabled('wanxiang-ai', false)
    await source.setCapability('wanxiang-ai', 'approval.read', false)
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    expect(JSON.parse(String(calls[1]?.[1].body))).toEqual({ connectorId: 'wanxiang-ai', enabled: false })
    expect(JSON.parse(String(calls[2]?.[1].body))).toEqual({ connectorId: 'wanxiang-ai', capabilityId: 'approval.read', enabled: false })
  })

  it('reports a broken bridge separately from a missing route', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'gateway down' }), { status: 502 })) as unknown as typeof fetch
    await expect(new HttpConnectorSource().list()).rejects.toThrow('gateway down')
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch
    await expect(new HttpConnectorSource().list()).rejects.toBeInstanceOf(ConnectorRequestError)
  })

  it('treats an HTML fallback answer as an absent route', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<!doctype html>', { status: 200 })) as unknown as typeof fetch
    await expect(new HttpConnectorSource().list()).rejects.toBeInstanceOf(ConnectorUnavailableError)
  })
})

describe('readConnectorCatalogue', () => {
  const demo = (): Connector[] => [{ id: 'demo', name: 'Demo', enabled: false, capabilities: [] }]

  it('falls back to the demo rows when the bridge has no route', async () => {
    const source = { list: async () => { throw new ConnectorUnavailableError('missing') }, setEnabled: async () => [], setCapability: async () => [] }
    await expect(readConnectorCatalogue(source, demo)).resolves.toEqual({
      connectors: demo(), demo: true,
    })
  })

  it('does not hide a real bridge failure behind the demo rows', async () => {
    const source = { list: async () => { throw new Error('boom') }, setEnabled: async () => [], setCapability: async () => [] }
    await expect(readConnectorCatalogue(source, demo)).rejects.toThrow('boom')
  })
})