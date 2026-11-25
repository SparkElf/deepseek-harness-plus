import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildConnectorView,
  readConnectorState,
  writeConnectorState,
  type DataOpsConnectorState,
} from '../src/connector-state.ts'

const temporary: string[] = []
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

async function path(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dataops-connector-'))
  temporary.push(directory)
  return join(directory, 'connector-state.json')
}

/** An ordinary portal user: no review queue, no administrator role. */
const USER_SCOPE = { roleCodes: ['应用人员'], permissions: [] }
/** A department administrator is not a portal administrator and sees only data.query. */
const DEPT_ADMIN_SCOPE = { roleCodes: ['部门管理员'], permissions: [] }
const ADMIN_SCOPE = { roleCodes: ['管理员'], permissions: [] }
const SUPER_ADMIN_SCOPE = { roleCodes: ['超级管理员'], permissions: [] }

const ids = (scope: Parameters<typeof buildConnectorView>[0]): string[] =>
  buildConnectorView(scope, { enabled: true, capabilities: {} }).capabilities.map(row => row.id)

describe('DataOps connector catalogue', () => {
  it('defaults to disabled and persists enabled/capability state', async () => {
    const file = await path()
    expect(await readConnectorState(file)).toEqual({ enabled: false, capabilities: {} })
    const next: DataOpsConnectorState = { enabled: true, capabilities: { 'resource.manage': false } }
    await writeConnectorState(next, file)
    expect(await readConnectorState(file)).toEqual(next)
  })

  it('lists the three capabilities in document order for an administrator', () => {
    const view = buildConnectorView(ADMIN_SCOPE, { enabled: true, capabilities: {} })
    expect(view.capabilities.map(row => row.id)).toEqual(['data.query', 'resource.manage', 'admin.manage'])
    expect(view.capabilities.map(row => row.name)).toEqual(['数据查询', '资源管理', '万相中台管理'])
    expect(view.capabilities.find(row => row.id === 'resource.manage')?.description)
      .toContain('批量审批资源申请')
    expect(view.capabilities.every(row => row.enabled && row.permitted)).toBe(true)
  })

  it('hides both administrative capabilities from non-administrators', () => {
    expect(ids(USER_SCOPE)).toEqual(['data.query'])
    expect(ids(DEPT_ADMIN_SCOPE)).toEqual(['data.query'])
  })

  it('shows all three to administrators and super administrators', () => {
    expect(ids(ADMIN_SCOPE)).toEqual(['data.query', 'resource.manage', 'admin.manage'])
    expect(ids(SUPER_ADMIN_SCOPE)).toEqual(['data.query', 'resource.manage', 'admin.manage'])
  })

  it('ignores retired keys and migrates approval.push onto resource.manage', async () => {
    const file = await path()
    await writeFile(file, JSON.stringify({
      enabled: true,
      capabilities: {
        'skill.plaza': false,
        'review.queue': true,
        'api.docs': false,
        'approval.push': false,
      },
    }), 'utf8')
    const state = await readConnectorState(file)
    expect(state).toEqual({ enabled: true, capabilities: { 'resource.manage': false } })
    const view = buildConnectorView(ADMIN_SCOPE, state)
    // The missing new keys fall back to defaultEnabled; the migrated toggle stays off.
    expect(view.capabilities.map(row => [row.id, row.enabled])).toEqual([
      ['data.query', true],
      ['resource.manage', false],
      ['admin.manage', true],
    ])
  })

  it('prefers the current id when both the alias and the new key are stored', async () => {
    const file = await path()
    await writeFile(file, JSON.stringify({
      enabled: true,
      capabilities: { 'approval.push': false, 'resource.manage': true },
    }), 'utf8')
    expect(await readConnectorState(file)).toEqual({ enabled: true, capabilities: { 'resource.manage': true } })
  })

  it('drops unknown keys on write and persists an alias under the current id', async () => {
    const file = await path()
    const legacy = {
      enabled: true,
      capabilities: { 'skill.plaza': false, 'approval.push': false },
    } as unknown as DataOpsConnectorState
    await writeConnectorState(legacy, file)
    const saved = JSON.parse(await readFile(file, 'utf8')) as { capabilities: Record<string, unknown> }
    expect(saved.capabilities).toEqual({ 'resource.manage': false })
  })

  it('returns no capabilities when no scope is known', () => {
    expect(buildConnectorView(undefined, { enabled: true, capabilities: {} }).capabilities).toEqual([])
  })
})
