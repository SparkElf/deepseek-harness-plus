/**
 * What the department folders actually print.
 *
 * The bucket stores folders by code so a department rename cannot move a document, but
 * the reader knows their organization by name. These pin the translation, including the
 * two things most likely to break it: translating rows that are not on the caller's own
 * chain, and translating the bucket root into a department name.
 */
import { describe, expect, it } from 'vitest'
import { departmentPathLabels, folderLabelOf } from '../src/client/departmentFolders.ts'

/** The three-level organization the product brief names. */
const CODES = ['nanning-psb', 'digital-recon', 'data-combat']
const NAMES = ['南宁市公安局', '数字侦察支队', '数据实战大队']

describe('department folder names', () => {
  it('labels every level of the caller chain, not only the leaf', () => {
    // The reader walks 部门 → 市局 → 支队 → 大队, so all three rows need a name.
    const labels = departmentPathLabels(CODES, NAMES)
    expect(labels?.get('department/nanning-psb')).toBe('南宁市公安局')
    expect(labels?.get('department/nanning-psb/digital-recon')).toBe('数字侦察支队')
    expect(labels?.get('department/nanning-psb/digital-recon/data-combat')).toBe('数据实战大队')
    expect(labels?.size).toBe(3)
  })

  it('leaves the department bucket itself to the audience label', () => {
    // Requirement: the root keeps saying 「部门」. The chain map must not contain it, or
    // the bucket would be renamed to the top-level department.
    const labels = departmentPathLabels(CODES, NAMES)
    expect(labels?.has('department')).toBe(false)
    expect(folderLabelOf('department', { department: '部门' }, labels)).toBe('部门')
  })

  it('does not translate a peer department', () => {
    // A sibling under the shared root has no name in this build. Printing its code is
    // honest; inventing a label would be worse.
    const labels = departmentPathLabels(CODES, NAMES)
    expect(labels?.get('department/business-ops')).toBeUndefined()
    expect(labels?.get('department/business-ops/crm-ops')).toBeUndefined()
    // A folder below the leaf is the department's own folder, not an organization
    // level, so it keeps its own name.
    expect(labels?.get('department/nanning-psb/digital-recon/data-combat/2026')).toBeUndefined()
  })

  it('answers undefined rather than a partial map when the pair does not line up', () => {
    // A half-labelled chain would show a name on one row and a raw code on the next,
    // which reads as a missing department rather than a missing translation.
    expect(departmentPathLabels(CODES, NAMES.slice(0, 2))).toBeUndefined()
    expect(departmentPathLabels(CODES, ['只有一个'])).toBeUndefined()
    expect(departmentPathLabels([], [])).toBeUndefined()
    expect(departmentPathLabels(undefined, NAMES)).toBeUndefined()
    expect(departmentPathLabels(CODES, undefined)).toBeUndefined()
  })

  it('refuses a chain with a blank or malformed entry', () => {
    expect(departmentPathLabels(['ok', ''], ['OK', '空'])).toBeUndefined()
    expect(departmentPathLabels(['ok', '  '], ['OK', '空白'])).toBeUndefined()
    expect(departmentPathLabels(['ok'], ['  '])).toBeUndefined()
  })

  it('trims both sides so a stray space cannot reach the tree', () => {
    const labels = departmentPathLabels([' nanning-psb '], [' 南宁市公安局 '])
    expect(labels?.get('department/nanning-psb')).toBe('南宁市公安局')
  })

  it('degrades to no translation when the backend reports no chain', () => {
    // The running deployment today: folders keep showing their codes, exactly as they
    // did before hierarchy existed. No throw, no empty label.
    const labels = departmentPathLabels(undefined, undefined)
    expect(labels).toBeUndefined()
    expect(folderLabelOf('department/data-platform', { department: '部门' }, labels)).toBeUndefined()
  })
})

describe('choosing which label a row prints', () => {
  const bucketLabels = { global: '全局', department: '部门', personal: '个人' }

  it('prefers the audience name for the three buckets', () => {
    expect(folderLabelOf('global', bucketLabels, undefined)).toBe('全局')
    expect(folderLabelOf('department', bucketLabels, undefined)).toBe('部门')
    expect(folderLabelOf('personal', bucketLabels, undefined)).toBe('个人')
  })

  it('prefers the audience name even if a chain somehow addresses the same row', () => {
    // The bucket's audience name is the one label a data value must not override.
    const overlapping = new Map([['department', '不该出现']])
    expect(folderLabelOf('department', bucketLabels, overlapping)).toBe('部门')
  })

  it('falls through to the chain name for a department folder', () => {
    const labels = departmentPathLabels(CODES, NAMES)
    expect(folderLabelOf('department/nanning-psb', bucketLabels, labels)).toBe('南宁市公安局')
    expect(folderLabelOf('department/nanning-psb/digital-recon', bucketLabels, labels)).toBe('数字侦察支队')
  })

  it('answers undefined for any other row, so the tree prints its own name', () => {
    const labels = departmentPathLabels(CODES, NAMES)
    expect(folderLabelOf('global/制度.md', bucketLabels, labels)).toBeUndefined()
    expect(folderLabelOf('department/nanning-psb/digital-recon/data-combat/plan.md', bucketLabels, labels)).toBeUndefined()
  })
})
