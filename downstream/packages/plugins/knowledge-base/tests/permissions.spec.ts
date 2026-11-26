import { describe, expect, it } from 'vitest'
import {
  ACTION_LABELS,
  BUILT_IN_ROLES,
  CONCRETE_ACTIONS,
  DEPARTMENT_ADMIN_ROLE,
  KNOWLEDGE_ACTIONS,
  SUPER_ADMIN_ROLE,
  builtInRoleActionsOn,
  builtInRoleCoversPath,
  builtInRoleOf,
  collapseActions,
  coversActions,
  dataOpsActionsToPermissions,
  decideRoleAction,
  departmentScopeOf,
  expandActions,
  isBuiltInRole,
  isKnowledgeAction,
  permissionToDataOpsActions,
} from '../src/permissions.ts'
import {
  formatGrantInstant,
  groupHoldingsByAccount,
  groupHoldingsByPrincipal,
  groupHoldingsByResource,
  groupHoldingsByRole,
  resolveActions,
  roleMemberCounts,
  summarizeActions,
} from '../src/client/permissionRows.ts'
import { buildRoleSummaries, summarizeRoleActions } from '../src/client/roleSummary.ts'

describe('the five knowledge permissions', () => {
  it('names exactly four concrete actions plus the union', () => {
    expect([...CONCRETE_ACTIONS]).toEqual(['read', 'create', 'update', 'delete'])
    expect([...KNOWLEDGE_ACTIONS]).toEqual(['read', 'create', 'update', 'delete', 'all'])
  })

  it('expands all into the four concrete actions, in a fixed order', () => {
    // The order matters: two callers holding the same privileges must produce the
    // same list, or comparing permissions would depend on input order.
    expect(expandActions(['all'])).toEqual(['read', 'create', 'update', 'delete'])
    expect(expandActions(['delete', 'read'])).toEqual(['read', 'delete'])
    expect(expandActions([])).toEqual([])
  })

  it('collapses a full house back to all and leaves a partial set explicit', () => {
    expect(collapseActions(['read', 'create', 'update', 'delete'])).toEqual(['all'])
    // Three of four is NOT all: showing `all` here would claim a privilege the
    // grant does not hold.
    expect(collapseActions(['read', 'create', 'update'])).toEqual(['read', 'create', 'update'])
    expect(collapseActions(['all'])).toEqual(['all'])
  })

  it('answers coverage from the held set, expanding both sides', () => {
    expect(coversActions(['all'], ['delete'])).toBe(true)
    expect(coversActions(['read'], ['read', 'delete'])).toBe(false)
    expect(coversActions(['read', 'delete'], ['read'])).toBe(true)
  })

  it('rejects a value that is not an action', () => {
    expect(isKnowledgeAction('read')).toBe(true)
    expect(isKnowledgeAction('all')).toBe(true)
    expect(isKnowledgeAction('manage')).toBe(false)
    expect(isKnowledgeAction(undefined)).toBe(false)
  })

  it('labels every action in both languages', () => {
    for (const action of KNOWLEDGE_ACTIONS) {
      expect(ACTION_LABELS[action].zh).not.toBe('')
      expect(ACTION_LABELS[action].en).not.toBe('')
    }
    expect(ACTION_LABELS.read.zh).toBe('查')
    expect(ACTION_LABELS.delete.zh).toBe('删')
    expect(ACTION_LABELS.all.zh).toBe('全部')
  })
})

describe('translating between product permissions and DataOps actions', () => {
  it('asks DataOps for the narrowest action that satisfies each permission', () => {
    expect(permissionToDataOpsActions('read')).toEqual(['read'])
    // DataOps has one `write` covering both creating and editing.
    expect(permissionToDataOpsActions('create')).toEqual(['write'])
    expect(permissionToDataOpsActions('update')).toEqual(['write'])
    expect(permissionToDataOpsActions('delete')).toEqual(['delete'])
    // One `manage`, not four grants: DataOps expands it, and four grants could
    // leave a half-applied state.
    expect(permissionToDataOpsActions('all')).toEqual(['manage'])
  })

  it('narrows DataOps actions into the permissions they actually justify', () => {
    expect(dataOpsActionsToPermissions(['read'])).toEqual(['read'])
    expect(dataOpsActionsToPermissions(['write'])).toEqual(['create', 'update'])
    expect(dataOpsActionsToPermissions(['manage'])).toEqual(['all'])
    expect(dataOpsActionsToPermissions(['read', 'delete'])).toEqual(['read', 'delete'])
  })

  it('ignores platform actions this plugin cannot enforce', () => {
    // `comment` and `share` would otherwise publish a permission with no effect.
    expect(dataOpsActionsToPermissions(['comment', 'share', 'audit'])).toEqual([])
    expect(dataOpsActionsToPermissions(['space_manage_page', 'page_write'])).toEqual([])
    expect(dataOpsActionsToPermissions([])).toEqual([])
  })
})

describe('built-in roles', () => {
  it('ships two roles, neither removable', () => {
    expect(BUILT_IN_ROLES.map(role => role.id)).toEqual([SUPER_ADMIN_ROLE, DEPARTMENT_ADMIN_ROLE])
    for (const role of BUILT_IN_ROLES) expect(role.removable).toBe(false)
    expect(isBuiltInRole(SUPER_ADMIN_ROLE)).toBe(true)
    expect(isBuiltInRole('some-custom-role')).toBe(false)
  })

  it('cannot be reached by a DataOps role of the same-ish name', () => {
    // The prefix is what keeps a platform role called `admin` from inheriting the
    // knowledge base's own super administrator.
    expect(builtInRoleOf('admin')).toBeUndefined()
    expect(builtInRoleOf('super-admin')).toBeUndefined()
  })

  it('lets the super administrator cover every path', () => {
    expect(builtInRoleCoversPath(SUPER_ADMIN_ROLE, 'global/制度.md', undefined)).toBe(true)
    expect(builtInRoleCoversPath(SUPER_ADMIN_ROLE, 'department/OPS/值班表.md', 'DEV')).toBe(true)
    expect(builtInRoleActionsOn(SUPER_ADMIN_ROLE, 'personal/u-1/笔记.md', undefined))
      .toEqual(['read', 'create', 'update', 'delete'])
  })

  it('limits the department administrator to its own department', () => {
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/OPS/值班表.md', 'OPS')).toBe(true)
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/OPS/2026/计划.md', 'OPS')).toBe(true)
    // A prefix match would leak OPS2 into OPS's scope; the trailing slash in the
    // scope is what prevents it.
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/OPS2/计划.md', 'OPS')).toBe(false)
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/DEV/计划.md', 'OPS')).toBe(false)
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'global/制度.md', 'OPS')).toBe(false)
  })

  it('gives the department administrator the department bucket itself', () => {
    // Managing a folder includes managing the folder, not only its documents.
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department', 'OPS')).toBe(true)
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/OPS', 'OPS')).toBe(true)
  })

  it('covers nothing for a department administrator with no department', () => {
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/OPS/x.md', undefined)).toBe(false)
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/OPS/x.md', '')).toBe(false)
    expect(builtInRoleActionsOn(DEPARTMENT_ADMIN_ROLE, 'department/OPS/x.md', undefined)).toEqual([])
  })

  it('builds a department scope only from a real code', () => {
    expect(departmentScopeOf('OPS')).toBe('department/OPS/')
    expect(departmentScopeOf(undefined)).toBeUndefined()
    expect(departmentScopeOf('  ')).toBeUndefined()
  })

  it('scopes the department administrator to its own level of the nested tree', () => {
    // With an organization path the caller's department is the LAST level, so the
    // prefix has to be the whole chain rather than a bare code that appears at
    // several depths.
    const chain = ['business-ops', 'biz-analysis']
    expect(departmentScopeOf('biz-analysis', chain)).toBe('department/business-ops/biz-analysis/')
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/business-ops/biz-analysis/x.md', 'biz-analysis', chain)).toBe(true)
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/business-ops/biz-analysis/2026/x.md', 'biz-analysis', chain)).toBe(true)
    // A peer that shares the ancestor must stay out: comparing the leaf alone would
    // let `business-ops/crm-ops` through.
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/business-ops/crm-ops/x.md', 'biz-analysis', chain)).toBe(false)
    // An ancestor's own folder is above the caller's scope, not inside it.
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/business-ops/x.md', 'biz-analysis', chain)).toBe(false)
    // The caller's own department container is theirs to manage.
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/business-ops/biz-analysis', 'biz-analysis', chain)).toBe(true)
  })

  it('keeps the flat answers when no path is reported', () => {
    // The degradation contract: an older backend must produce exactly the permissions
    // this build had before hierarchy existed.
    expect(departmentScopeOf('OPS', [])).toBe('department/OPS/')
    expect(departmentScopeOf('OPS', undefined)).toBe('department/OPS/')
    expect(builtInRoleActionsOn(DEPARTMENT_ADMIN_ROLE, 'department/OPS/x.md', 'OPS', []))
      .toEqual(builtInRoleActionsOn(DEPARTMENT_ADMIN_ROLE, 'department/OPS/x.md', 'OPS'))
  })
})

describe('deciding one role action with an explanation', () => {
  it('allows what the role covers', () => {
    const decision = decideRoleAction(SUPER_ADMIN_ROLE, 'global/制度.md', 'delete', undefined)
    expect(decision.covered).toBe(true)
    expect(decision.actions).toEqual(['read', 'create', 'update', 'delete'])
    expect(decision.reason).toBeUndefined()
  })

  it('names a path outside the department as the reason, not just "denied"', () => {
    const decision = decideRoleAction(DEPARTMENT_ADMIN_ROLE, 'department/DEV/x.md', 'read', 'OPS')
    expect(decision.covered).toBe(false)
    expect(decision.reason).toContain('OPS')
  })

  it('separates an unknown role from a permission problem', () => {
    // A stale screen and a permission request need different fixes, so they must
    // not read the same.
    const unknown = decideRoleAction('not-a-role', 'global/x.md', 'read', undefined)
    expect(unknown.reason).toContain('unknown role')
    const outside = decideRoleAction(DEPARTMENT_ADMIN_ROLE, 'global/x.md', 'read', 'OPS')
    expect(outside.reason).not.toContain('unknown role')
  })
})

describe('permission overview grouping', () => {
  it('summarizes in the vocabulary DataOps actually stores', () => {
    // These words come from the backend's grant summary (`read`/`write`/`manage`),
    // NOT from the create/edit form (`create`/`update`/`delete`). An earlier version
    // filtered on the form words, so every `write` and `manage` grant was dropped and
    // an administrator holding all three displayed as "read only". This test used to
    // assert that defect -- it passed while the screen lied.
    expect(summarizeActions(['read', 'write', 'manage'])).toEqual(['read', 'write', 'manage'])
    expect(summarizeActions(['read'])).toEqual(['read'])
    expect(summarizeActions([])).toEqual([])
    // A full house still collapses, now expressed in the real words.
    expect(summarizeActions(['all'])).toEqual(['read', 'write', 'manage'])
  })

  it('unions a principal grants instead of reading one row', () => {
    // Read and write arrive on separate rows; what the principal holds is both.
    expect(resolveActions(['read', 'write'])).toEqual({ actions: ['read', 'write'], known: true })
    // Duplicates and case do not change the answer.
    expect(resolveActions(['READ', 'write', 'read'])).toEqual({ actions: ['read', 'write'], known: true })
  })

  it('reports an unknown action word rather than silently dropping it', () => {
    // Under-reporting a permission is the dangerous direction: it tells an operator
    // that access is lower than it is.
    const resolved = resolveActions(['read', 'share'])
    expect(resolved.known).toBe(false)
    expect(resolved.reason).toContain('share')
  })

  it('groups one person into one row even across several grants', () => {
    // "What does 张三 have" is a question about a person; splitting them per path
    // would answer it wrong.
    const people = groupHoldingsByPrincipal([
      { id: '1', relPath: 'global/a.md', kind: 'file', principalType: 'user', principalId: 'u-1', action: 'read', grantedBy: 'admin', grantedAt: '2026-01-01' },
      { id: '2', relPath: 'global/b.md', kind: 'file', principalType: 'user', principalId: 'u-1', action: 'write', grantedBy: 'admin', grantedAt: '2026-01-01' },
    ], { 'user:u-1': '张三' })
    expect(people).toHaveLength(1)
    expect(people[0]?.label).toBe('张三')
    expect(people[0]?.paths).toEqual(['global/a.md', 'global/b.md'])
  })

  it('groups one resource with everyone who reaches it', () => {
    const resources = groupHoldingsByResource([
      { id: '1', relPath: 'global/a.md', kind: 'file', principalType: 'user', principalId: 'u-1', action: 'read', grantedBy: 'admin', grantedAt: '2026-01-01' },
      { id: '2', relPath: 'global/a.md', kind: 'file', principalType: 'role', principalId: 'knowledge-dept-admin', action: 'manage', grantedBy: 'admin', grantedAt: '2026-01-01' },
    ], { 'user:u-1': '张三', 'role:knowledge-dept-admin': '部门管理员' })
    expect(resources).toHaveLength(1)
    expect(resources[0]?.principals.map(p => p.label)).toEqual(['张三', '部门管理员'].sort())
  })

  it('reads roles out of role grants only, built-ins first', () => {
    const roles = buildRoleSummaries([
      { id: '1', relPath: 'global', kind: 'directory', principalType: 'role', principalId: 'knowledge-super-admin', action: 'manage', grantedBy: 'admin', grantedAt: '2026-01-01' },
      { id: '2', relPath: 'department/OPS', kind: 'directory', principalType: 'role', principalId: 'custom-role', action: 'read', grantedBy: 'admin', grantedAt: '2026-01-01' },
      // A user grant is not a role; inventing one per user would flood the list.
      { id: '3', relPath: 'global/x.md', kind: 'file', principalType: 'user', principalId: 'u-1', action: 'read', grantedBy: 'admin', grantedAt: '2026-01-01' },
    ])
    expect(roles.map(r => r.id)).toEqual(['knowledge-super-admin', 'custom-role'])
    expect(roles[0]?.label).toBe('超级管理员')
    expect(roles[0]?.builtIn).toBe(true)
    expect(roles[1]?.builtIn).toBe(false)
  })
})

describe('the two tabbed readings of one grant table', () => {
  /**
   * The page has ONE body: two tabs over the same payload. These pin the parts the
   * tabs depend on — that each row carries the grants a revoke must name, and that
   * the two readings agree about the same underlying set.
   */
  const GRANTS = [
    { id: '1', relPath: 'global/a.md', kind: 'file' as const, principalType: 'user' as const, principalId: 'u-1', action: 'read', grantedBy: 'admin', grantedAt: '2026-01-01T00:00:00Z' },
    { id: '2', relPath: 'global/b.md', kind: 'file' as const, principalType: 'user' as const, principalId: 'u-1', action: 'write', grantedBy: 'admin', grantedAt: '2026-03-02T00:00:00Z' },
    { id: '3', relPath: 'global/a.md', kind: 'file' as const, principalType: 'role' as const, principalId: 'knowledge-super-admin', action: 'manage', grantedBy: 'admin', grantedAt: '2026-02-01T00:00:00Z' },
  ]

  it('carries the exact grants a row revokes, so the action removes what it shows', () => {
    const people = groupHoldingsByPrincipal(GRANTS)
    const zhang = people.find(person => person.principalId === 'u-1')
    // Two grants behind one row: the revoke has to name both, or it would silently
    // leave half of what the row displays.
    expect(zhang?.grants.map(grant => grant.id)).toEqual(['1', '2'])
  })

  it('names the principal kind on each person row', () => {
    // The type column needs it; without it the table could only print the id.
    const people = groupHoldingsByPrincipal(GRANTS)
    expect(people.every(person => person.principalType !== undefined)).toBe(true)
  })

  it('agrees with the resource reading about the same grants', () => {
    // Two readings of one payload must not disagree: every grant appears exactly
    // once on each side, or the tabs would tell different stories.
    const people = groupHoldingsByPrincipal(GRANTS)
    const resources = groupHoldingsByResource(GRANTS)
    const personTotal = people.reduce((sum, person) => sum + person.grants.length, 0)
    const resourceTotal = resources.reduce(
      (sum, resource) => sum + resource.principals.reduce((inner, holder) => inner + holder.grants.length, 0), 0)
    expect(personTotal).toBe(GRANTS.length)
    expect(resourceTotal).toBe(GRANTS.length)
  })

  it('gives every holder on a path its own grants, for the row-level revoke', () => {
    const resources = groupHoldingsByResource(GRANTS)
    const globalA = resources.find(resource => resource.relPath === 'global/a.md')
    // Two principals can reach global/a.md; revoking the row must cover both.
    const all = globalA?.principals.flatMap(holder => holder.grants) ?? []
    expect(all.map(grant => grant.id).sort()).toEqual(['1', '3'])
  })

  it('takes the newest instant as the row date, not the first one seen', () => {
    // A row spans several grants, so its date is the latest of them. Compared as
    // instants rather than as a formatted string: the formatter prints local time,
    // so pinning the printed text would make this fail in another time zone.
    const people = groupHoldingsByPrincipal(GRANTS)
    const zhang = people.find(person => person.principalId === 'u-1')
    expect(zhang?.latestAt).toBe('2026-03-02T00:00:00Z')
    // …and that it is later than the row's other grant, which is the actual claim.
    expect(new Date(zhang?.latestAt ?? 0).getTime())
      .toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime())
  })

  it('formats a missing instant as a dash rather than an epoch date', () => {
    expect(formatGrantInstant('')).toBe('-')
  })
})

describe('the three permission views', () => {
  /** A minimal grant row; only the fields grouping reads are meaningful. */
  function grant(over: Partial<import('../src/api.ts').GrantView> & { id: string }): import('../src/api.ts').GrantView {
    return {
      relPath: 'global/a.md',
      kind: 'file',
      principalType: 'user',
      principalId: 'u-1',
      action: 'read',
      grantedBy: 'admin',
      grantedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    }
  }

  /** The directory the page gets from `/api/system/users`, reduced. */
  const directory = {
    kind: 'available' as const,
    users: [
      { userId: 'u-1', username: 'zhang', displayName: '张三', roleCodes: ['管理员'] },
      { userId: 'u-2', username: 'li', displayName: '李四', roleCodes: [] },
    ],
  }

  it('attributes a role grant to every member of that role', () => {
    // The defect being fixed: a reader whose access is entirely role-derived appeared
    // on no row, so "by person" said nobody had access while they could write.
    const rows = groupHoldingsByAccount(
      [grant({ id: 'g1', principalType: 'role', principalId: '管理员', action: 'write' })],
      directory,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.userId).toBe('u-1')
    expect(rows[0]?.label).toBe('张三')
    expect(rows[0]?.paths).toEqual(['global/a.md'])
    expect(rows[0]?.viaRoles).toEqual(['管理员'])
    expect(rows[0]?.resolved).toEqual({ actions: ['write'], known: true })
  })

  it('unions a direct grant with an inherited one on the same account', () => {
    // THE key case: one person holding a direct read AND an inherited write must show
    // read+write -- not read (first row), not write (last row), and not the intersection.
    const rows = groupHoldingsByAccount(
      [
        grant({ id: 'g1', principalType: 'user', principalId: 'u-1', action: 'read' }),
        grant({ id: 'g2', principalType: 'role', principalId: '管理员', action: 'write' }),
        grant({ id: 'g3', principalType: 'role', principalId: '管理员', action: 'manage' }),
      ],
      directory,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.resolved).toEqual({ actions: ['read', 'write', 'manage'], known: true })
    expect(rows[0]?.directGrants.map(g => g.id)).toEqual(['g1'])
    expect(rows[0]?.viaRoles).toEqual(['管理员'])
  })

  it('does not merge two different accounts into one row', () => {
    // A role covers several people: each gets their own row, not one shared row.
    const rows = groupHoldingsByAccount(
      [grant({ id: 'g1', principalType: 'role', principalId: '管理员', action: 'read' })],
      { kind: 'available', users: [
        { userId: 'u-1', username: 'zhang', displayName: '张三', roleCodes: ['管理员'] },
        { userId: 'u-2', username: 'li', displayName: '李四', roleCodes: ['管理员'] },
      ] },
    )
    expect(rows.map(row => row.userId).sort()).toEqual(['u-1', 'u-2'])
    expect(rows.every(row => row.resolved.actions.includes('read'))).toBe(true)
  })

  it('marks inheritance unknown instead of pretending the account holds nothing', () => {
    // The safety net: without the directory a role grant cannot be attributed, and
    // showing "read only, directly granted" would be a false negative.
    const rows = groupHoldingsByAccount(
      [
        grant({ id: 'g1', principalType: 'user', principalId: 'u-1', action: 'read' }),
        grant({ id: 'g2', principalType: 'role', principalId: '管理员', action: 'write' }),
      ],
      { kind: 'unavailable', reason: 'requires administrator access' },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.inheritanceKnown).toBe(false)
    expect(rows[0]?.inheritanceReason).toContain('administrator')
    // The direct half is still correct and still shown.
    expect(rows[0]?.resolved).toEqual({ actions: ['read'], known: true })
  })

  it('lists roles separately from accounts', () => {
    // The old "by person" tab showed the administrators; those rows belong here.
    const rows = groupHoldingsByRole(
      [
        grant({ id: 'g1', principalType: 'role', principalId: '管理员', action: 'read' }),
        grant({ id: 'g2', principalType: 'role', principalId: '管理员', action: 'write' }),
        grant({ id: 'g3', principalType: 'role', principalId: '超级管理员', action: 'manage' }),
        grant({ id: 'g4', principalType: 'user', principalId: 'u-1', action: 'read' }),
      ],
      {},
      roleMemberCounts(directory),
    )
    // Sorted by label via localeCompare, which orders 管理员 before 超级管理员.
    expect(rows.map(row => row.roleCode)).toEqual(['管理员', '超级管理员'])
    const admin = rows.find(row => row.roleCode === '管理员')
    expect(admin?.resolved).toEqual({ actions: ['read', 'write'], known: true })
    expect(admin?.memberCount).toBe(1)
    expect(admin?.paths).toEqual(['global/a.md'])
  })

  it('reports a role whose grant actions cannot be read as unknown, not as read-only', () => {
    // Safety net for the role view: an unreadable action word must not render as a
    // lower permission than it is.
    const rows = groupHoldingsByRole([
      grant({ id: 'g1', principalType: 'role', principalId: '管理员', action: 'share' }),
    ])
    expect(rows[0]?.resolved.known).toBe(false)
    expect(rows[0]?.resolved.reason).toContain('share')
  })

  it('omits the member count rather than claiming zero when the directory is unknown', () => {
    expect(roleMemberCounts({ kind: 'unavailable', reason: 'x' })).toBeUndefined()
    const rows = groupHoldingsByRole(
      [grant({ id: 'g1', principalType: 'role', principalId: '管理员', action: 'read' })],
      {},
      roleMemberCounts({ kind: 'unavailable', reason: 'x' }),
    )
    expect(rows[0]?.memberCount).toBeUndefined()
  })

  it('does not invent a row for a directory account that holds nothing', () => {
    const rows = groupHoldingsByAccount(
      [grant({ id: 'g1', principalType: 'user', principalId: 'u-1', action: 'read' })],
      directory,
    )
    // u-2 has no grants and no roles, so it is not a permission row.
    expect(rows.map(row => row.userId)).toEqual(['u-1'])
  })
})

describe('the role badges agree with the table below them', () => {
  /**
   * The page showed two answers for one role: the badges said 「只读」 while the table
   * said 读/写/管理. The cause was a SECOND action vocabulary inside `roleSummary.ts`
   * (`read`/`create`/`update`/`delete`), which matched none of DataOps' stored words
   * (`read`/`write`/`manage`) and silently dropped two of them.
   *
   * These pin that the badge and the row are computed from the same rule, because a
   * page that disagrees with itself is worse than one that is wrong consistently.
   */
  const ROLE_GRANTS = [
    { id: '1', relPath: '@kb-root', kind: 'directory' as const, principalType: 'role' as const, principalId: '管理员', action: 'read', grantedBy: '', grantedAt: '' },
    { id: '2', relPath: '@kb-root', kind: 'directory' as const, principalType: 'role' as const, principalId: '管理员', action: 'write', grantedBy: '', grantedAt: '' },
    { id: '3', relPath: '@kb-root', kind: 'directory' as const, principalType: 'role' as const, principalId: '管理员', action: 'manage', grantedBy: '', grantedAt: '' },
  ]

  it('summarizes a role badge with the same union the table uses', () => {
    const badges = buildRoleSummaries(ROLE_GRANTS)
    const rows = groupHoldingsByRole(ROLE_GRANTS)
    expect(badges).toHaveLength(1)
    expect(rows).toHaveLength(1)
    // THE assertion: badge and row must not disagree.
    expect(badges[0]?.actions).toEqual(rows[0]?.resolved.actions)
    // And the value must be the real one, not the old read-only reading.
    expect(badges[0]?.actions).toEqual(['read', 'write', 'manage'])
  })

  it('does not invent a collapse word the table would not use', () => {
    // The old summarizer returned ['all'] for a full house. `resolveActions` returns
    // the concrete words, so the badge and the chips read the same.
    expect(summarizeRoleActions(['read', 'write', 'manage'])).toEqual(['read', 'write', 'manage'])
    expect(summarizeRoleActions(['read'])).toEqual(['read'])
  })
})
