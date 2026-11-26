/**
 * The redline / provenance decision matrix.
 *
 * These assertions are the backend contract, not a UI behaviour test: the browser
 * never gets to be the only guard, so the deny cases are named explicitly and each
 * one carries a stable reason code. The matrix covers both subjects (node, edge),
 * both blocking flags (`authority: redline`, `internalizable: false`), the edge
 * endpoint inheritance rule, and the admin/owner gates on publish/setAuthority.
 */
import { describe, expect, it } from 'vitest'
import {
  decideMemoryAction,
  runtimeInjectionTags,
  type GraphViewer,
  type MemoryAction,
  type PolicyEdge,
  type PolicyNode,
} from '../src/memoryPolicy.ts'

const admin: GraphViewer = {
  userId: 'admin-1',
  isAdmin: true,
  isSuperAdmin: false,
  visibleDepartmentCodes: ['root'],
}

const superAdmin: GraphViewer = {
  userId: 'root-1',
  isAdmin: false,
  isSuperAdmin: true,
  visibleDepartmentCodes: ['root'],
}

const owner: GraphViewer = {
  userId: 'user-1',
  isAdmin: false,
  isSuperAdmin: false,
  departmentCode: 'dept-a',
  visibleDepartmentCodes: ['dept-a'],
}

const member: GraphViewer = {
  userId: 'user-2',
  isAdmin: false,
  isSuperAdmin: false,
  departmentCode: 'dept-a',
  visibleDepartmentCodes: ['dept-a'],
}

function node(overrides: Partial<PolicyNode> = {}): PolicyNode {
  return {
    id: 'node-1',
    authority: 'advisory',
    internalizable: true,
    origin: 'human',
    reviewStatus: 'draft',
    ...overrides,
  }
}

function edge(overrides: Partial<PolicyEdge> = {}): PolicyEdge {
  return {
    id: 'edge-1',
    authority: 'advisory',
    internalizable: true,
    ...overrides,
  }
}

const ACTIONS: MemoryAction[] = ['view', 'subscribe', 'internalize', 'edit', 'publish', 'setAuthority']

describe('decideMemoryAction subject handling', () => {
  for (const action of ACTIONS) {
    it(`denies ${action} when no subject is supplied`, () => {
      expect(decideMemoryAction({ action, viewer: admin, isOwner: true })).toEqual({
        allowed: false,
        reason: 'missing-subject',
      })
    })
  }

  it('refuses an ambiguous node+edge subject instead of guessing', () => {
    expect(decideMemoryAction({ action: 'internalize', node: node(), edge: edge() })).toEqual({
      allowed: false,
      reason: 'ambiguous-subject',
    })
  })
})

describe('view and subscribe keep redlines readable', () => {
  it('allows viewing an ordinary node without marking it non-overridable', () => {
    expect(decideMemoryAction({ action: 'view', node: node() })).toEqual({ allowed: true })
  })

  it('allows viewing a redline: visibility is not the redline restriction', () => {
    expect(decideMemoryAction({ action: 'view', node: node({ authority: 'redline', internalizable: false }) })).toEqual({
      allowed: true,
    })
  })

  it('allows subscribing to an ordinary node', () => {
    expect(decideMemoryAction({ action: 'subscribe', node: node() })).toEqual({ allowed: true })
  })

  it('allows subscribing to a redline: the proxy is the only intended mode', () => {
    expect(decideMemoryAction({ action: 'subscribe', node: node({ authority: 'redline', internalizable: false }) })).toEqual({
      allowed: true,
    })
  })

  it('allows subscribing to an internalizable:false node', () => {
    expect(decideMemoryAction({ action: 'subscribe', node: node({ internalizable: false }) })).toEqual({ allowed: true })
  })

  it('allows viewing and subscribing to a redline edge', () => {
    const redlineEdge = edge({ authority: 'redline', internalizable: false })
    expect(decideMemoryAction({ action: 'view', edge: redlineEdge })).toEqual({ allowed: true })
    expect(decideMemoryAction({ action: 'subscribe', edge: redlineEdge })).toEqual({ allowed: true })
  })
})

describe('internalize rejects redlines and non-internalizable nodes', () => {
  it('allows an ordinary advisory node', () => {
    expect(decideMemoryAction({ action: 'internalize', node: node(), viewer: owner })).toEqual({ allowed: true })
  })

  it('allows a canonical node', () => {
    expect(decideMemoryAction({ action: 'internalize', node: node({ authority: 'canonical' }), viewer: owner })).toEqual({ allowed: true })
  })

  it('rejects a redline node and marks the rejection non-overridable', () => {
    expect(decideMemoryAction({
      action: 'internalize',
      node: node({ authority: 'redline' }),
      viewer: owner,
    })).toEqual({ allowed: false, reason: 'redline', nonOverridable: true })
  })

  it('rejects authority redline even when internalizable was left true', () => {
    expect(decideMemoryAction({
      action: 'internalize',
      node: node({ authority: 'redline', internalizable: true }),
      viewer: owner,
    })).toEqual({ allowed: false, reason: 'redline', nonOverridable: true })
  })

  it('rejects internalizable:false even when authority is advisory', () => {
    expect(decideMemoryAction({
      action: 'internalize',
      node: node({ internalizable: false }),
      viewer: owner,
    })).toEqual({ allowed: false, reason: 'not-internalizable' })
  })
})

describe('internalize makes the relation inherit both endpoint policies', () => {
  it('allows an ordinary edge', () => {
    expect(decideMemoryAction({ action: 'internalize', edge: edge(), viewer: owner })).toEqual({ allowed: true })
  })

  it('rejects a redline edge', () => {
    expect(decideMemoryAction({
      action: 'internalize',
      edge: edge({ authority: 'redline' }),
      viewer: owner,
    })).toEqual({ allowed: false, reason: 'redline', nonOverridable: true })
  })

  it('rejects an internalizable:false edge', () => {
    expect(decideMemoryAction({
      action: 'internalize',
      edge: edge({ internalizable: false }),
      viewer: owner,
    })).toEqual({ allowed: false, reason: 'not-internalizable' })
  })

  it('rejects an advisory edge when either endpoint is a redline', () => {
    expect(decideMemoryAction({
      action: 'internalize',
      edge: edge(),
      edgeEndpoints: [node({ id: 'a', authority: 'redline' }), node({ id: 'b' })],
      viewer: owner,
    })).toEqual({ allowed: false, reason: 'redline', nonOverridable: true })
  })

  it('rejects an advisory edge when either endpoint is not internalizable', () => {
    expect(decideMemoryAction({
      action: 'internalize',
      edge: edge(),
      edgeEndpoints: [node({ id: 'a' }), node({ id: 'b', internalizable: false })],
      viewer: owner,
    })).toEqual({ allowed: false, reason: 'not-internalizable' })
  })

  it('allows an edge only when the edge and both endpoints are internalizable', () => {
    expect(decideMemoryAction({
      action: 'internalize',
      edge: edge(),
      edgeEndpoints: [node({ id: 'a' }), node({ id: 'b', origin: 'ai' })],
      viewer: owner,
    })).toEqual({ allowed: true })
  })

  it('keeps an edge redline even when both endpoints are advisory', () => {
    expect(decideMemoryAction({
      action: 'internalize',
      edge: edge({ authority: 'redline' }),
      edgeEndpoints: [node({ id: 'a' }), node({ id: 'b' })],
      viewer: owner,
    })).toEqual({ allowed: false, reason: 'redline', nonOverridable: true })
  })
})

describe('personal edit never overrides a redline', () => {
  it('allows the owner to edit an ordinary personal node', () => {
    expect(decideMemoryAction({ action: 'edit', node: node(), viewer: owner, isOwner: true })).toEqual({ allowed: true })
  })

  it('allows the owner to edit a canonical personal node', () => {
    expect(decideMemoryAction({
      action: 'edit',
      node: node({ authority: 'canonical', origin: 'ai', reviewStatus: 'reviewed' }),
      viewer: owner,
      isOwner: true,
    })).toEqual({ allowed: true })
  })

  it('rejects an edit by someone who does not own the memory', () => {
    expect(decideMemoryAction({ action: 'edit', node: node(), viewer: member })).toEqual({
      allowed: false,
      reason: 'owner-required',
    })
  })

  it('rejects the owner editing a redline inherited from the department/global graph', () => {
    expect(decideMemoryAction({
      action: 'edit',
      node: node({ authority: 'redline' }),
      viewer: owner,
      isOwner: true,
    })).toEqual({ allowed: false, reason: 'redline', nonOverridable: true })
  })

  it('rejects a non-owner edit of a redline for the stronger redline reason', () => {
    expect(decideMemoryAction({
      action: 'edit',
      node: node({ authority: 'redline' }),
      viewer: member,
    })).toEqual({ allowed: false, reason: 'redline', nonOverridable: true })
  })
})

describe('publish requires origin and admin/owner rights', () => {
  it('allows an admin to publish AI-generated content that carries origin', () => {
    expect(decideMemoryAction({
      action: 'publish',
      node: node({ origin: 'ai', reviewStatus: 'draft' }),
      viewer: admin,
    })).toEqual({ allowed: true })
  })

  it('allows the owner to publish mixed-origin content', () => {
    expect(decideMemoryAction({
      action: 'publish',
      node: node({ origin: 'mixed' }),
      viewer: owner,
      isOwner: true,
    })).toEqual({ allowed: true })
  })

  it('allows a super admin to publish human content', () => {
    expect(decideMemoryAction({ action: 'publish', node: node(), viewer: superAdmin })).toEqual({ allowed: true })
  })

  it('denies publishing when origin is undefined, even for an admin', () => {
    expect(decideMemoryAction({
      action: 'publish',
      node: node({ origin: undefined }),
      viewer: admin,
    })).toEqual({ allowed: false, reason: 'missing-origin' })
  })

  it('denies publishing when origin is undefined, even for the owner', () => {
    expect(decideMemoryAction({
      action: 'publish',
      node: node({ origin: undefined }),
      viewer: owner,
      isOwner: true,
    })).toEqual({ allowed: false, reason: 'missing-origin' })
  })

  it('denies a regular member publishing AI content', () => {
    expect(decideMemoryAction({
      action: 'publish',
      node: node({ origin: 'ai' }),
      viewer: member,
    })).toEqual({ allowed: false, reason: 'admin-or-owner-required' })
  })

  it('denies publishing when no viewer was supplied', () => {
    expect(decideMemoryAction({ action: 'publish', node: node({ origin: 'ai' }) })).toEqual({
      allowed: false,
      reason: 'admin-or-owner-required',
    })
  })

  it('denies publishing for an anonymous admin-shaped viewer', () => {
    expect(decideMemoryAction({
      action: 'publish',
      node: node({ origin: 'ai' }),
      viewer: { ...admin, userId: '  ' },
    })).toEqual({ allowed: false, reason: 'admin-or-owner-required' })
  })

  it('denies publishing an edge through the node-only action', () => {
    expect(decideMemoryAction({ action: 'publish', edge: edge(), viewer: admin })).toEqual({
      allowed: false,
      reason: 'missing-subject',
    })
  })

  it('still lets an admin publish a redline node without changing its authority', () => {
    expect(decideMemoryAction({
      action: 'publish',
      node: node({ authority: 'redline', internalizable: false, origin: 'human' }),
      viewer: admin,
    })).toEqual({ allowed: true })
  })
})

describe('setAuthority is admin/owner only', () => {
  it('allows an admin', () => {
    expect(decideMemoryAction({ action: 'setAuthority', node: node(), viewer: admin })).toEqual({ allowed: true })
  })

  it('allows the owner', () => {
    expect(decideMemoryAction({ action: 'setAuthority', node: node(), viewer: owner, isOwner: true })).toEqual({ allowed: true })
  })

  it('denies a regular member', () => {
    expect(decideMemoryAction({ action: 'setAuthority', node: node(), viewer: member })).toEqual({
      allowed: false,
      reason: 'admin-or-owner-required',
    })
  })

  it('denies a caller with no viewer', () => {
    expect(decideMemoryAction({ action: 'setAuthority', node: node() })).toEqual({
      allowed: false,
      reason: 'admin-or-owner-required',
    })
  })

  it('denies a caller with an empty user id even when admin is true', () => {
    expect(decideMemoryAction({
      action: 'setAuthority',
      node: node(),
      viewer: { ...admin, userId: '' },
    })).toEqual({ allowed: false, reason: 'admin-or-owner-required' })
  })

  it('denies an edge subject: authority is a node-level setting', () => {
    expect(decideMemoryAction({ action: 'setAuthority', edge: edge(), viewer: admin })).toEqual({
      allowed: false,
      reason: 'missing-subject',
    })
  })
})

describe('runtimeInjectionTags', () => {
  it('marks a redline node non-overridable and keeps both tags', () => {
    expect(runtimeInjectionTags({
      authority: 'redline',
      origin: 'ai',
      internalizable: false,
    })).toEqual({ authorityTag: '红线', originTag: 'AI 生成', nonOverridable: true })
  })

  it('does not mark non-redline authority as non-overridable', () => {
    expect(runtimeInjectionTags({ authority: 'canonical', origin: 'human' })).toEqual({
      authorityTag: '权威',
      originTag: '人工',
      nonOverridable: false,
    })
  })

  it('labels mixed origin as AI+人工', () => {
    expect(runtimeInjectionTags({ authority: 'advisory', origin: 'mixed' })).toEqual({
      authorityTag: '建议',
      originTag: 'AI+人工',
      nonOverridable: false,
    })
  })

  it('treats internalizable:false alone as overridable: only redline is special', () => {
    expect(runtimeInjectionTags({ authority: 'advisory', origin: 'human', internalizable: false })).toEqual({
      authorityTag: '建议',
      originTag: '人工',
      nonOverridable: false,
    })
  })

  it('falls back to human origin for legacy nodes without provenance', () => {
    expect(runtimeInjectionTags({ authority: 'advisory' })).toEqual({
      authorityTag: '建议',
      originTag: '人工',
      nonOverridable: false,
    })
  })
})
