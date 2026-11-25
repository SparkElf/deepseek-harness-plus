/**
 * Super-administrator-only declarations for the automation workflow tools.
 *
 * The four workflow tools are served by the DataOps MCP endpoint, so the plugin's registry never
 * owns a definition for them; what it owns is the disclosure declaration. These cases pin both
 * halves of that contract: the access table names all four, and the derived inventory and the
 * MCP public-name mapping reach the same rule that hides them from every non-super-administrator.
 *
 * @module tests/tool-scope.test
 */

import { describe, expect, it } from 'vitest'
import {
  AI_TOOL_ACCESS,
  AI_TOOL_NAMES,
  declaredMcpToolName,
  isToolVisible,
  sessionHidesTool,
  type AiToolName,
  type DataOpsScope,
} from '../src/tool-scope.ts'

const SUPER_ADMIN: DataOpsScope = {
  userId: 'super',
  roleCodes: ['超级管理员'],
  primaryRole: '超级管理员',
  permissions: [],
}

const ADMIN: DataOpsScope = {
  userId: 'admin',
  roleCodes: ['管理员'],
  primaryRole: '管理员',
  permissions: ['skill:read'],
}

const MEMBER: DataOpsScope = {
  userId: 'member',
  roleCodes: ['应用人员'],
  primaryRole: '应用人员',
  permissions: [],
}

const WORKFLOW_TOOLS = [
  'workflow_query',
  'workflow_definition',
  'workflow_deployment',
  'workflow_run_control',
] as const satisfies readonly AiToolName[]

const COLLECT_TOOLS = [
  'dataops_collect_preview',
  'dataops_collect_validate_plan',
  'dataops_collect_execute',
  'dataops_collect_resources',
] as const satisfies readonly AiToolName[]

const STAFF = {
  userId: 'staff',
  roleCodes: ['应用人员'],
  permissions: ['data:resource:manage', 'data:resource:read'],
}

describe('collection tools are resource-management gated', () => {
  it('declares preview/validate/execute and no model-backed plan tool', () => {
    for (const name of COLLECT_TOOLS) {
      expect(AI_TOOL_NAMES).toContain(name)
      expect(isToolVisible(name, STAFF)).toBe(true)
    }
    // Plan generation moved to the current conversation model; a shared-model plan tool must
    // not linger in the disclosure table.
    expect(AI_TOOL_NAMES).not.toContain('dataops_collect_plan')
    expect(AI_TOOL_ACCESS.dataops_collect_validate_plan).toEqual({ permission: 'data:resource:manage' })
  })

  it('hides the mutating collect tools from a scope without the resource permission', () => {
    for (const name of COLLECT_TOOLS) {
      expect(isToolVisible(name, MEMBER)).toBe(false)
    }
  })
})

describe('automation workflow tools are super-administrator only', () => {
  it('declares each tool in the access table and the derived inventory', () => {
    for (const name of WORKFLOW_TOOLS) {
      expect(AI_TOOL_ACCESS[name]).toEqual({ superAdminOnly: true })
      // `AI_TOOL_NAMES` is derived from the table, so a declaration cannot be forgotten there.
      expect(AI_TOOL_NAMES).toContain(name)
    }
  })

  it('keeps the tools visible to 超级管理员 and hidden from administrators and members', () => {
    for (const name of WORKFLOW_TOOLS) {
      expect(isToolVisible(name, SUPER_ADMIN)).toBe(true)
      expect(isToolVisible(name, ADMIN)).toBe(false)
      expect(isToolVisible(name, MEMBER)).toBe(false)
    }
  })

  it('reads the same declaration from the MCP public name', () => {
    expect(declaredMcpToolName('mcp__dataops__workflow_query', 'dataops')).toBe('workflow_query')
    expect(declaredMcpToolName('mcp__dataops__workflow_run_control', 'dataops')).toBe('workflow_run_control')
    // An MCP tool the table does not name stays outside this plugin's disclosure rule.
    expect(declaredMcpToolName('mcp__dataops__query', 'dataops')).toBeUndefined()
    // A different server namespace is another trust domain.
    expect(declaredMcpToolName('mcp__other__workflow_query', 'dataops')).toBeUndefined()
  })

  it('hides the workflow tools from a Session acting for a non-super-administrator', () => {
    // A room Session carries the member's scope as its actor; the workspace registration set is the
    // super administrator's here, so only the actor's declaration can hide the tool.
    expect(sessionHidesTool('workflow_query', ADMIN, SUPER_ADMIN)).toBe(true)
    expect(sessionHidesTool('workflow_query', MEMBER, SUPER_ADMIN)).toBe(true)
    // An actor who is the super administrator keeps them, and an ordinary Session is unchanged.
    expect(sessionHidesTool('workflow_query', SUPER_ADMIN, ADMIN)).toBe(false)
    expect(sessionHidesTool('workflow_query', undefined, SUPER_ADMIN)).toBe(false)
    expect(sessionHidesTool('workflow_query', undefined, ADMIN)).toBe(true)
  })
})
