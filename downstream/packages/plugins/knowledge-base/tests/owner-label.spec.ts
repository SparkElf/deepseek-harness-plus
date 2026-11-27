/**
 * Ownership is a property of the bucket, so these cases pin the mapping from path shape
 * to owner rather than any rendering detail.
 */
import { describe, expect, it } from 'vitest'
import { ownerLabelOf } from '../src/client/ownerLabel.ts'

const labels = { global: 'Everyone', self: 'Me', unknown: 'Unassigned' }
const me = { callerId: 'u-1', departmentCode: 'data-combat', departmentName: '数据实战大队' }

describe('the owner of a knowledge document', () => {
  it('names the shared bucket for global documents', () => {
    expect(ownerLabelOf('global/a.md', me, labels)).toEqual({ kind: 'global', label: 'Everyone' })
  })

  it('names the caller for their own personal folder', () => {
    expect(ownerLabelOf('personal/u-1/note.md', me, labels)).toEqual({ kind: 'self', label: 'Me' })
  })

  it('names the other person for a folder that is not the caller own', () => {
    expect(ownerLabelOf('personal/u-2/note.md', me, labels))
      .toEqual({ kind: 'person', label: 'u-2' })
  })

  it('names the caller department when the path ends in that department', () => {
    expect(ownerLabelOf('department/business-ops/data-combat/plan.md', me, labels))
      .toEqual({ kind: 'department', label: '数据实战大队' })
  })

  it('shows the code for a department the caller cannot name', () => {
    expect(ownerLabelOf('department/business-ops/crm-ops/plan.md', me, labels))
      .toEqual({ kind: 'department', label: 'crm-ops' })
  })

  it('treats a flat department path as the caller own department', () => {
    expect(ownerLabelOf('department/legacy.md', me, labels))
      .toEqual({ kind: 'department', label: '数据实战大队' })
  })

  it('treats a personal path without an owner segment as the caller own folder', () => {
    expect(ownerLabelOf('personal/note.md', me, labels))
      .toEqual({ kind: 'self', label: 'Me' })
  })

  it('never returns an empty label', () => {
    for (const path of ['global/a.md', 'department/x/y.md', 'personal/u/1/n.md', 'loose.md']) {
      expect(ownerLabelOf(path, {}, labels).label.length).toBeGreaterThan(0)
    }
  })
})
