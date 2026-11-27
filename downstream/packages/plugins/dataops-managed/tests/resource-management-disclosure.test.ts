import { describe, expect, it } from 'vitest'
import {
  AI_TOOL_ACCESS,
  isToolCapabilityEnabled,
  isToolVisible,
  type AiToolName,
} from '../src/tool-scope.ts'

const RESOURCE_TOOLS: AiToolName[] = [
  'dataops_resource_pending_list',
  'dataops_resource_grant_list',
  'dataops_resource_grant_batch',
  'dataops_resource_approval_decide',
  'dataops_resource_grant_revoke',
]

const ADMIN = { roleCodes: ['管理员'], primaryRole: '管理员', permissions: ['data:resource:manage'] }
const ORDINARY = { roleCodes: ['应用人员'], primaryRole: '应用人员', permissions: ['data:resource:read'] }

describe('resource-management tool disclosure', () => {
  it('marks all five tools as resource.manage + adminOnly', () => {
    for (const name of RESOURCE_TOOLS) {
      expect(AI_TOOL_ACCESS[name]).toMatchObject({ capability: 'resource.manage', adminOnly: true })
    }
  })

  it('registers all five for an administrator when the capability is on', () => {
    const state = { enabled: true, capabilities: { 'resource.manage': true } }
    expect(RESOURCE_TOOLS.filter(name => isToolVisible(name, ADMIN) && isToolCapabilityEnabled(name, state))).toHaveLength(5)
  })

  it('registers none for an ordinary user even when the capability is on', () => {
    const state = { enabled: true, capabilities: { 'resource.manage': true } }
    expect(RESOURCE_TOOLS.filter(name => isToolVisible(name, ORDINARY) && isToolCapabilityEnabled(name, state))).toHaveLength(0)
  })

  it('removes the whole group when resource.manage is off or the connector is disabled', () => {
    expect(RESOURCE_TOOLS.filter(name => isToolCapabilityEnabled(name, {
      enabled: true,
      capabilities: { 'resource.manage': false },
    }))).toHaveLength(0)
    expect(RESOURCE_TOOLS.filter(name => isToolCapabilityEnabled(name, {
      enabled: false,
      capabilities: { 'resource.manage': true },
    }))).toHaveLength(0)
  })

  it('treats a missing capability bit as the connector default (on)', () => {
    expect(RESOURCE_TOOLS.every(name => isToolCapabilityEnabled(name, {
      enabled: true,
      capabilities: {},
    }))).toBe(true)
  })
})
