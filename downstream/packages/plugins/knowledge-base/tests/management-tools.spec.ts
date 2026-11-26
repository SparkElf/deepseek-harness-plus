// @ts-nocheck
import { describe, expect, it, vi } from 'vitest'
import {
  ManagementToolError,
  assertNoSecretFields,
  createManagementTools,
  isDepartmentReviewer,
  isGlobalAdmin,
  isPathInDepartmentScope,
  redactSecrets,
  requireCapability,
  requireConfirmed,
  normalizePublishScope,
  requirePathScope,
  type ManagementContext,
} from '../src/managementTools.ts'

const admin: ManagementContext = {
  userId: 'admin', roleCodes: ['SUPER_ADMIN'],
  permissions: ['kb:file:read', 'kb:file:write', 'kb:file:delete', 'kb:file:extract', 'kb:audit:read',
    'kb:grant:manage', 'kb:review:decide', 'workflow:read', 'workflow:publish', 'workflow:manage',
    'workflow:review:decide', 'workflow:review:global'],
  dataScope: { all: true, self: true, departmentCodes: [] },
  review: { canReview: true, canReviewGlobal: true, canManagePermissions: true, departments: [] },
}
const deptAdmin: ManagementContext = {
  userId: 'dept', roleCodes: ['DEPT_ADMIN'], departmentCode: 'data-platform',
  permissions: ['kb:file:read', 'kb:file:write', 'kb:file:delete', 'kb:file:extract', 'kb:audit:read',
    'kb:grant:manage', 'kb:review:decide', 'workflow:read', 'workflow:publish', 'workflow:manage',
    'workflow:review:decide'],
  dataScope: { all: false, self: true, departmentCodes: ['data-platform', 'data-platform-child'] },
  review: { canReview: true, canReviewGlobal: false, canManagePermissions: false, departments: ['data-platform', 'data-platform-child'] },
}
const normal: ManagementContext = {
  userId: 'u1', roleCodes: ['USER'], departmentCode: 'data-platform',
  permissions: ['kb:file:read', 'kb:file:write', 'kb:file:delete', 'kb:file:extract', 'workflow:read', 'workflow:publish'],
  dataScope: { all: false, self: true, departmentCodes: [] },
  review: { canReview: false, canReviewGlobal: false, canManagePermissions: false, departments: [] },
}

describe('management tool capability matrix', () => {
  it('recognises global and department administrators', () => {
    expect(isGlobalAdmin(admin)).toBe(true)
    expect(isGlobalAdmin(deptAdmin)).toBe(false)
    expect(isDepartmentReviewer(deptAdmin)).toBe(true)
    expect(isDepartmentReviewer(normal)).toBe(false)
  })

  it('refuses global config to a department admin and all reviews to a normal user', () => {
    expect(() => requireCapability(admin, 'global')).not.toThrow()
    expect(() => requireCapability(deptAdmin, 'global')).toThrow(ManagementToolError)
    expect(() => requireCapability(deptAdmin, 'reviewer')).not.toThrow()
    expect(() => requireCapability(normal, 'reviewer')).toThrow(ManagementToolError)
    expect(() => requireCapability(normal, 'reader')).not.toThrow()
  })

  it('limits department paths to the department and its descendants', () => {
    expect(isPathInDepartmentScope(deptAdmin, 'department/data-platform/a.md')).toBe(true)
    expect(isPathInDepartmentScope(deptAdmin, 'department/data-platform-child/a.md')).toBe(true)
    expect(isPathInDepartmentScope(deptAdmin, 'department/other/a.md')).toBe(false)
    expect(isPathInDepartmentScope(deptAdmin, 'global/a.md')).toBe(false)
    expect(() => requirePathScope(deptAdmin, 'department/other/a.md')).toThrow(ManagementToolError)
    expect(() => requirePathScope(admin, 'global/a.md')).not.toThrow()
  })

  it('requires a human authorization flag for writes', () => {
    expect(() => requireConfirmed(undefined)).toThrow(ManagementToolError)
    expect(() => requireConfirmed({ confirmed: false })).toThrow(ManagementToolError)
    expect(() => requireConfirmed({ confirmed: true, reason: 'operator approved' })).not.toThrow()
  })
})

describe('management tool execution relies on disclosure', () => {
  it('does not read the permission context for a disclosure-gated read', async () => {
    const context = vi.fn(async () => {
      throw new Error('a disclosure-gated tool must not re-read the permission context per call')
    })
    const tools = createManagementTools({
      context,
      kbConfigGet: async () => ({ storageMode: 'local' }),
    } as never)
    const configTool = tools.find(tool => tool.name === 'kb_config_get')!
    await expect((configTool.execute as never)({}, {} as never))
      .resolves.toMatchObject({ config: { storageMode: 'local' } })
    expect(context).not.toHaveBeenCalled()
  })

})

describe('workflow publish scope', () => {
  it('allows global visibility only to platform admins', () => {
    expect(normalizePublishScope(admin, 'global', undefined)).toEqual({ visibility: 'global', departmentCode: '' })
    expect(() => normalizePublishScope(deptAdmin, 'global', undefined)).toThrow(ManagementToolError)
    expect(() => normalizePublishScope(normal, 'global', undefined)).toThrow(ManagementToolError)
  })

  it('limits department visibility to the caller department for non-global users', () => {
    expect(normalizePublishScope(normal, 'department', undefined)).toEqual({ visibility: 'department', departmentCode: 'data-platform' })
    expect(() => normalizePublishScope(normal, 'department', 'other')).toThrow(ManagementToolError)
    expect(normalizePublishScope(admin, 'department', 'other')).toEqual({ visibility: 'department', departmentCode: 'other' })
  })

  it('defaults to private and ignores a stray department for private scope', () => {
    expect(normalizePublishScope(normal, undefined, 'other')).toEqual({ visibility: 'private', departmentCode: '' })
    expect(normalizePublishScope(admin, 'private', 'data-platform')).toEqual({ visibility: 'private', departmentCode: '' })
  })
})

describe('management secret handling', () => {
  it('redacts secret-shaped keys on reads', () => {
    expect(redactSecrets({
      storageMode: 'local',
      apiKey: 'sk-secret',
      nested: { accessToken: 'abc', credentialRef: 'DATAOPS_ACCESS_TOKEN' },
    })).toEqual({
      storageMode: 'local',
      apiKey: '***',
      nested: { accessToken: '***', credentialRef: 'DATAOPS_ACCESS_TOKEN' },
    })
  })

  it('refuses secret-shaped fields on writes', () => {
    expect(() => assertNoSecretFields({ reviewRequired: true })).not.toThrow()
    expect(() => assertNoSecretFields({ apiKey: 'sk-x' })).toThrow(ManagementToolError)
    expect(() => assertNoSecretFields({ nested: [{ password: 'x' }] })).toThrow(ManagementToolError)
  })
})

describe('management tool surface', () => {
  it('registers all KB and workflow management tools', () => {
    const host = {} as never
    const names = createManagementTools(host).map(tool => tool.name)
    expect(names).toEqual([
      'kb_config_get', 'kb_config_update', 'kb_grant_list', 'kb_grant_set',
      'kb_audit_list', 'kb_review_list', 'kb_review_decide', 'kb_sync',
      'kb_index_rebuild',
      'workflow_list', 'workflow_update', 'workflow_unpublish',
      'workflow_review_list', 'workflow_review_scan', 'workflow_review_decide',
    ])
  })

  it('mentions human authorization and audit in write descriptions', () => {
    const tools = createManagementTools({} as never)
    for (const name of ['kb_config_update', 'kb_grant_set', 'kb_review_decide', 'workflow_update', 'workflow_unpublish', 'workflow_review_decide']) {
      expect(tools.find(tool => tool.name === name)?.description).toMatch(/authorization\.confirmed|人工授权/i)
    }
  })
})

describe('management tool data scoping after disclosure', () => {
  const host = (context: ManagementContext) => ({
    context: async () => context,
    kbGrantList: async () => [
      { relPath: 'department/other/a.md' },
      { relPath: 'department/data-platform/b.md' },
    ],
    kbAuditList: async () => [
      { at: '2026-10-01T00:00:00.000Z', actor: 'someone-else', action: 'create', relPath: 'global/a.md' },
      { at: '2026-10-02T00:00:00.000Z', actor: 'u1', action: 'create', relPath: 'personal/u1/b.md' },
    ],
    kbReviewList: async () => [
      { name: 'one', userId: 'u1', relPath: 'department/data-platform/a.md', at: '', bytes: 1 },
    ],
    workflowList: async () => [],
  }) as never

  it('filters grants, audit and review rows by context instead of re-refusing the tool', async () => {
    const tools = createManagementTools(host(normal))
    const grants = await (tools.find(item => item.name === 'kb_grant_list')!.execute as never)({}, {} as never)
    expect(grants).toEqual({ grants: [] })
    const audit = await (tools.find(item => item.name === 'kb_audit_list')!.execute as never)({}, {} as never)
    expect(audit).toEqual({ entries: [{ at: '2026-10-02T00:00:00.000Z', actor: 'u1', action: 'create', relPath: 'personal/u1/b.md' }] })
    const review = await (tools.find(item => item.name === 'kb_review_list')!.execute as never)({}, {} as never)
    expect(review).toEqual({ pending: [] })
  })

  it('keeps the human-confirmation gate while leaving disclosure to registration', async () => {
    const unpublish = vi.fn(async () => ({ unpublished: 'wf-1' }))
    const tools = createManagementTools({ workflowUnpublish: unpublish } as never)
    const tool = tools.find(item => item.name === 'workflow_unpublish')!
    await expect((tool.execute as never)({ id: 'wf-1', authorization: { confirmed: false } }, {} as never))
      .rejects.toMatchObject({ code: 'forbidden' })
    await expect((tool.execute as never)({ id: 'wf-1', authorization: { confirmed: true } }, {} as never))
      .resolves.toEqual({ result: { unpublished: 'wf-1' } })
    expect(unpublish).toHaveBeenCalledWith('wf-1')
  })
})
