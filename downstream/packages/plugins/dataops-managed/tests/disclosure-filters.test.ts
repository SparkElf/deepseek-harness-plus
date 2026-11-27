/**
 * Per-session disclosure: a room acts for one member, an ordinary conversation for the workspace.
 *
 * These cases pin the predicates the plugin hands to the base's filter registries. The base itself
 * is covered by its own patch tests; what matters here is which scope wins and that an ordinary
 * Session is untouched.
 *
 * @module tests/disclosure-filters.test
 */

import { describe, expect, it } from 'vitest'
import {
  isToolVisible,
  sessionHidesSkill,
  sessionHidesTool,
  skillPermissions,
  type AiToolName,
  type DataOpsScope,
} from '../src/tool-scope.ts'

/** An ordinary staff scope: no administration, and the resource permission the collect tools need. */
const STAFF: DataOpsScope = {
  userId: 'staff',
  roleCodes: ['应用人员'],
  permissions: ['data:resource:manage'],
}

/** A narrower scope: no permissions at all, so every permission-gated tool is out of reach. */
const LIMITED: DataOpsScope = { userId: 'limited', roleCodes: ['应用人员'], permissions: [] }

/** A permission-gated tool, a super-admin-only one, and one every role may call. */
const GATED: AiToolName = 'dataops_collect_preview'
const ADMIN_ONLY: AiToolName = 'dataops_api_docs'

describe('the Session scope a disclosure rule reads', () => {
  it('keeps an ordinary Session on the workspace scope, exactly as registration decided', () => {
    // No actor: the answer must equal what the registration set already encoded, so nothing moves.
    for (const name of [GATED, ADMIN_ONLY] as const) {
      expect(sessionHidesTool(name, undefined, STAFF)).toBe(!isToolVisible(name, STAFF))
    }
    expect(sessionHidesTool(GATED, undefined, STAFF)).toBe(false)
    expect(sessionHidesTool(ADMIN_ONLY, undefined, STAFF)).toBe(true)
  })

  it('lets a room actor decide instead of the workspace', () => {
    // The workspace allows the gated tool; this member's scope does not, so the room hides it even
    // though the tool is registered for the workspace.
    expect(sessionHidesTool(GATED, LIMITED, STAFF)).toBe(true)
    expect(sessionHidesTool(GATED, STAFF, LIMITED)).toBe(false)
  })

  it('hides everything when the Session carries an actor it cannot read', () => {
    // An opaque value that is not one of ours must not fall through to the workspace's scope: the
    // Session belongs to someone else.
    expect(sessionHidesTool(GATED, { unrelated: true }, STAFF)).toBe(true)
    expect(sessionHidesTool(GATED, 'opaque', STAFF)).toBe(true)
    expect(sessionHidesTool(GATED, undefined, undefined)).toBe(true)
  })

  it('requires every declared skill permission from the effective scope', () => {
    expect(sessionHidesSkill(['data:resource:manage'], undefined, STAFF)).toBe(false)
    expect(sessionHidesSkill(['data:resource:manage'], undefined, LIMITED)).toBe(true)
    expect(sessionHidesSkill(['data:resource:manage'], LIMITED, STAFF)).toBe(true)
    expect(sessionHidesSkill(['data:resource:manage'], STAFF, LIMITED)).toBe(false)
  })


  it('hides every tool whose access is not declared from a Session acting for someone else', () => {
    // `dataops_open_resource_tab` and the notification readers carry no policy: they were written
    // for the workspace principal, and a visitor must not inherit them.
    const undeclared: AiToolName = 'dataops_open_resource_tab'
    expect(isToolVisible(undeclared, STAFF)).toBe(true)
    expect(sessionHidesTool(undeclared, STAFF, STAFF)).toBe(true)
    // The same tool stays visible to an ordinary conversation, which is the workspace itself.
    expect(sessionHidesTool(undeclared, undefined, STAFF)).toBe(false)
  })

  it('hides skills that declare nothing from a Session acting for someone else', () => {
    expect(sessionHidesSkill([], STAFF, STAFF)).toBe(true)
    expect(sessionHidesSkill([], undefined, STAFF)).toBe(false)
    expect(sessionHidesSkill(['data:resource:manage'], STAFF, STAFF)).toBe(false)
  })

  it('reads only well-formed permission declarations from frontmatter', () => {
    expect(skillPermissions({ permissions: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(skillPermissions({ permissions: ['a', 3, null] })).toEqual(['a'])
    expect(skillPermissions({ permissions: 'a' })).toEqual([])
    expect(skillPermissions(undefined)).toEqual([])
  })
})