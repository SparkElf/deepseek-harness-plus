import { describe, expect, it } from 'vitest'
import {
  canManageGraph,
  canViewGraph,
  filterVisibleGraphs,
  type GraphScopeDescriptor,
  type GraphViewer,
} from '../src/graphPolicy.ts'

const member: GraphViewer = {
  userId: 'u-member',
  isAdmin: false,
  isSuperAdmin: false,
  departmentCode: 'dept-a',
  visibleDepartmentCodes: ['dept-a'],
}

const deptAdmin: GraphViewer = {
  userId: 'u-dept-admin',
  isAdmin: false,
  isSuperAdmin: false,
  departmentCode: 'dept-a',
  visibleDepartmentCodes: ['dept-a', 'dept-a/child'],
  manageableDepartmentCodes: ['dept-a', 'dept-a/child'],
}

const admin: GraphViewer = {
  userId: 'u-admin',
  isAdmin: true,
  isSuperAdmin: false,
  visibleDepartmentCodes: ['dept-a', 'dept-a/child'],
  manageableDepartmentCodes: ['dept-a', 'dept-a/child'],
}

const superAdmin: GraphViewer = {
  userId: 'u-root',
  isAdmin: true,
  isSuperAdmin: true,
  visibleDepartmentCodes: [],
  manageableDepartmentCodes: [],
}

const unauthenticated: GraphViewer = {
  userId: '   ',
  isAdmin: false,
  isSuperAdmin: false,
  visibleDepartmentCodes: ['dept-a'],
}

const privateOfMember: GraphScopeDescriptor = { visibility: 'private', ownerId: 'u-member' }
const privateOfDeptAdmin: GraphScopeDescriptor = { visibility: 'private', ownerId: 'u-dept-admin' }
const globalGraph: GraphScopeDescriptor = { visibility: 'global' }
const deptA: GraphScopeDescriptor = { visibility: 'department', departmentCode: 'dept-a' }
const deptChild: GraphScopeDescriptor = { visibility: 'department', departmentCode: 'dept-a/child' }
const deptB: GraphScopeDescriptor = { visibility: 'department', departmentCode: 'dept-b' }
const departmentWithoutCode: GraphScopeDescriptor = { visibility: 'department' }

describe('canViewGraph', () => {
  it('shows a private graph to its owner and to nobody else', () => {
    expect(canViewGraph(member, privateOfMember)).toBe(true)
    expect(canViewGraph(deptAdmin, privateOfMember)).toBe(false)
    expect(canViewGraph(admin, privateOfDeptAdmin)).toBe(false)
    // The super administrator sees every department but not another user's private graph.
    expect(canViewGraph(superAdmin, privateOfDeptAdmin)).toBe(false)
    expect(canViewGraph(member, { visibility: 'private' })).toBe(false)
  })

  it('shows global graphs to every authenticated viewer', () => {
    expect(canViewGraph(member, globalGraph)).toBe(true)
    expect(canViewGraph(deptAdmin, globalGraph)).toBe(true)
    expect(canViewGraph(superAdmin, globalGraph)).toBe(true)
    expect(canViewGraph(unauthenticated, globalGraph)).toBe(false)
  })

  it('shows department graphs only inside the visible subtree', () => {
    expect(canViewGraph(member, deptA)).toBe(true)
    expect(canViewGraph(member, deptChild)).toBe(false)
    expect(canViewGraph(member, deptB)).toBe(false)
    expect(canViewGraph(deptAdmin, deptChild)).toBe(true)
    expect(canViewGraph(deptAdmin, deptB)).toBe(false)
    expect(canViewGraph(admin, deptB)).toBe(false)
  })

  it('lets a super administrator read every department, including unlisted ones', () => {
    expect(canViewGraph(superAdmin, deptA)).toBe(true)
    expect(canViewGraph(superAdmin, deptChild)).toBe(true)
    expect(canViewGraph(superAdmin, deptB)).toBe(true)
  })

  it('treats a managed department as visible to its administrator', () => {
    const scopedAdmin: GraphViewer = {
      userId: 'u-scoped-admin',
      isAdmin: true,
      isSuperAdmin: false,
      visibleDepartmentCodes: ['dept-a'],
      manageableDepartmentCodes: ['dept-b'],
    }

    expect(canViewGraph(scopedAdmin, deptB)).toBe(true)
  })

  it('denies a department graph with no department code', () => {
    expect(canViewGraph(member, departmentWithoutCode)).toBe(false)
    expect(canViewGraph(superAdmin, departmentWithoutCode)).toBe(false)
  })
})

describe('canManageGraph', () => {
  it('lets a private owner manage their own graph and nobody else', () => {
    expect(canManageGraph(member, privateOfMember)).toBe(true)
    expect(canManageGraph(deptAdmin, privateOfMember)).toBe(false)
    expect(canManageGraph(admin, privateOfDeptAdmin)).toBe(false)
    expect(canManageGraph(superAdmin, privateOfDeptAdmin)).toBe(false)
  })

  it('restricts global graphs to administrators', () => {
    expect(canManageGraph(member, globalGraph)).toBe(false)
    expect(canManageGraph(deptAdmin, globalGraph)).toBe(false)
    expect(canManageGraph(admin, globalGraph)).toBe(true)
    expect(canManageGraph(superAdmin, globalGraph)).toBe(true)
  })

  it('requires the department in manageableDepartmentCodes', () => {
    // A department administrator has the list without the platform admin flag.
    expect(canManageGraph(deptAdmin, deptA)).toBe(true)
    expect(canManageGraph(deptAdmin, deptChild)).toBe(true)
    expect(canManageGraph(deptAdmin, deptB)).toBe(false)
    expect(canManageGraph(member, deptA)).toBe(false)
    // Visibility alone is not management: the admin list stops at the managed subtree.
    expect(canViewGraph(admin, deptB)).toBe(false)
    expect(canManageGraph(admin, deptB)).toBe(false)
    expect(canManageGraph(admin, deptChild)).toBe(true)
  })

  it('lets a super administrator manage every department', () => {
    expect(canManageGraph(superAdmin, deptA)).toBe(true)
    expect(canManageGraph(superAdmin, deptB)).toBe(true)
  })

  it('never manages a graph the viewer cannot see', () => {
    // dept-b is manageable but not visible only if the caller failed to expand the
    // subtree; the management answer still requires visibility.
    const invisibleButManageable: GraphViewer = {
      userId: 'u-scoped-desk',
      isAdmin: false,
      isSuperAdmin: false,
      visibleDepartmentCodes: [],
      manageableDepartmentCodes: ['dept-b'],
    }
    expect(canManageGraph(invisibleButManageable, deptB)).toBe(false)
    expect(canManageGraph(unauthenticated, deptA)).toBe(false)
  })
})

describe('filterVisibleGraphs', () => {
  it('keeps the readable graphs in input order', () => {
    const graphs = [
      { id: 'global', scope: globalGraph },
      { id: 'dept', scope: deptA },
      { id: 'private-own', scope: privateOfMember },
      { id: 'private-other', scope: privateOfDeptAdmin },
      { id: 'dept-child', scope: deptChild },
    ]

    expect(filterVisibleGraphs(member, graphs).map(graph => graph.id)).toEqual([
      'global',
      'dept',
      'private-own',
    ])
    expect(filterVisibleGraphs(deptAdmin, graphs).map(graph => graph.id)).toEqual([
      'global',
      'dept',
      'private-other',
      'dept-child',
    ])
    expect(filterVisibleGraphs(unauthenticated, graphs)).toEqual([])
  })

  it('returns an empty list rather than exposing denied names', () => {
    expect(filterVisibleGraphs(member, [{ id: 'secret', scope: privateOfDeptAdmin }])).toEqual([])
  })
})
