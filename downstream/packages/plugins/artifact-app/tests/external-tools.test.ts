import type { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactApi } from '../src/api.ts'
import type { Config } from '../src/config.ts'
import { registerCockpitTools } from '../src/tools.ts'

const row = {
  id: 'ext-1',
  name: '销售驾驶舱',
  description: '外部销售分析',
  url: 'https://cockpit.example/sales',
  icon: null,
  tags: ['sales'],
  ownerId: 'user-1',
  visibility: 'DEPARTMENT' as const,
  credentialType: 'http' as const,
  credentialHint: '域账号',
  enabled: true,
  health: 'ok',
  updatedAt: '2026-11-26T10:00:00.000Z',
}

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>
}

const tools = new Map<string, ToolDefinition>()
const api = {
  searchExternalCockpits: vi.fn(async () => ({ items: [row], total: 1, page: 1, pageSize: 20 })),
  getExternalCockpit: vi.fn(async () => row),
  linkExternalCockpit: vi.fn(async () => ({
    id: 'ext-1',
    url: 'https://cockpit.example/sales',
    expiresAt: null,
    mode: 'stable',
    // A defensive extra: the tool must never echo ticket-like fields.
    ticket: 'secret-ticket',
  })),
}

beforeEach(() => {
  tools.clear()
  vi.clearAllMocks()
  const ctx = {
    effect: (callback: () => (() => void) | undefined) => { callback(); return () => undefined },
    tools: {
      register: (definition: ToolDefinition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  } as unknown as Context
  registerCockpitTools({
    ctx,
    api: api as unknown as ArtifactApi,
    hub: {} as never,
    config: { workspaceRoot: '/workspace', htmlMaxBytes: 1024 } as Config,
  })
})

const tool = (name: string): ToolDefinition => {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error('missing tool ' + name)
  return definition
}

describe('external cockpit tools', () => {
  it('registers exactly the M1 discovery tools', () => {
    expect([...tools.keys()].filter((name) => name.startsWith('external_cockpit_')).sort()).toEqual([
      'external_cockpit_get',
      'external_cockpit_link',
      'external_cockpit_search',
    ])
  })

  it('searches the registry with query, tag and a clamped limit', async () => {
    const result = await tool('external_cockpit_search').execute({ query: '销售', tag: 'crm', limit: 500 }, {})
    expect(result).toMatchObject({ ok: true, total: 1, page: 1 })
    expect((result.items as unknown[]).length).toBe(1)
    expect(api.searchExternalCockpits).toHaveBeenCalledWith({
      search: '销售',
      tag: 'crm',
      page: 1,
      pageSize: 50,
    })

    await tool('external_cockpit_search').execute({ limit: 0 }, {})
    expect(api.searchExternalCockpits).toHaveBeenLastCalledWith({
      search: undefined,
      tag: undefined,
      page: 1,
      pageSize: 1,
    })
  })

  it('gets metadata by id', async () => {
    const result = await tool('external_cockpit_get').execute({ id: 'ext-1' }, {})
    expect(result).toMatchObject({ ok: true, cockpit: row })
    expect(api.getExternalCockpit).toHaveBeenCalledWith('ext-1')
  })

  it('returns a stable link without tickets', async () => {
    const result = await tool('external_cockpit_link').execute({ id: 'ext-1' }, {})
    expect(result).toMatchObject({ ok: true, id: 'ext-1', url: 'https://cockpit.example/sales', mode: 'stable' })
    expect(JSON.stringify(result)).not.toContain('secret-ticket')
    expect(JSON.stringify(result)).not.toContain('ticket"')
  })

  it('rejects arbitrary URLs and path-like ids before calling DataOps', async () => {
    const get = tool('external_cockpit_get')
    await expect(get.execute({ id: 'javascript:alert(1)' }, {})).rejects.toThrow('id 非法')
    await expect(get.execute({ id: '../../etc/passwd' }, {})).rejects.toThrow('id 非法')
    const link = tool('external_cockpit_link')
    await expect(link.execute({ id: 'https://evil.example/cockpit' }, {})).rejects.toThrow('id 非法')
    expect(api.getExternalCockpit).not.toHaveBeenCalled()
    expect(api.linkExternalCockpit).not.toHaveBeenCalled()
  })

  it('exposes no url parameter on any external tool', () => {
    const properties = (name: string): string[] => {
      const schema = tool(name).parameters as { properties?: Record<string, unknown> }
      return Object.keys(schema.properties ?? {})
    }
    for (const name of ['external_cockpit_search', 'external_cockpit_get', 'external_cockpit_link']) {
      expect(properties(name)).not.toContain('url')
    }
    expect(properties('external_cockpit_get')).toEqual(['id'])
    expect(properties('external_cockpit_link')).toEqual(['id'])
  })
})
