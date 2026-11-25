/**
 * The department filter on the skill plaza: which choices the visible rows offer,
 * how a missing department name falls back to the code, and which rows each
 * choice shows. The chip tag filter was removed, so no helper here reads tags.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  departmentKeyOf,
  departmentOptionsOf,
  filterByDepartment,
} from '../src/client/SkillPlazaSection.tsx'
import type { PlazaSkill } from '../src/client/skill-plaza-client.ts'

// The component imports the shell's primitives for its render tree; these helpers are pure, so
// the primitives are stubbed instead of pulling the whole UI kit into a Node test.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: () => null,
  IconDownloadOutlineRegular: () => null,
  IconRefreshOutlineRegular: () => null,
  IconShareOutlineRegular: () => null,
  IconSkillOutlineRegular: () => null,
  IconTrashOutlineRegular: () => null,
  Modal: () => null,
}))

function skill(overrides: Partial<PlazaSkill> & Pick<PlazaSkill, 'id' | 'name'>): PlazaSkill {
  return {
    instruction: '',
    tags: [],
    sharedByMe: false,
    updatedAt: '',
    reviewStatus: 'approved',
    visibility: 'global',
    departmentCode: null,
    ...overrides,
  }
}

const rows: PlazaSkill[] = [
  skill({ id: 1, name: '月度报表生成' }),
  skill({ id: 2, name: 'Dept Review Demo', visibility: 'department', departmentCode: 'crm-ops', departmentName: '客户运营', departmentPath: [{ code: 'business-ops', name: '业务运营中心' }, { code: 'crm-ops', name: '客户运营' }] }),
  skill({ id: 3, name: 'Auto Approved Demo', visibility: 'department', departmentCode: 'crm-ops', departmentName: '客户运营' }),
  // A row the backend no longer names: the deepest path entry still labels it.
  skill({ id: 4, name: 'Legacy Dept Skill', visibility: 'department', departmentCode: 'legacy-ops', departmentPath: [{ code: 'root', name: '万相' }, { code: 'legacy-ops', name: '旧运营部' }] }),
  // A deleted department: nothing but the code is left, and the code is the label.
  skill({ id: 5, name: 'Orphan Dept Skill', visibility: 'department', departmentCode: 'retired-ops' }),
  skill({ id: 6, name: '私有技能', visibility: 'private', departmentCode: 'crm-ops', departmentName: '客户运营' }),
]

describe('plaza department filter', () => {
  it('keys a row by code, then name, then the deepest path name', () => {
    expect(departmentKeyOf(rows[1]!)).toBe('crm-ops')
    expect(departmentKeyOf(skill({ id: 9, name: 'named', visibility: 'department', departmentName: '研发部' }))).toBe('研发部')
    expect(departmentKeyOf(skill({ id: 10, name: 'pathed', visibility: 'department', departmentPath: [{ code: 'd', name: '研发部' }] }))).toBe('研发部')
    expect(departmentKeyOf(rows[0]!)).toBe('')
  })

  it('offers each department once and never leaves a label empty', () => {
    const options = departmentOptionsOf(rows)
    expect(options).toHaveLength(3)
    const byCode = new Map(options.map(option => [option.code, option.name]))
    expect(byCode.get('crm-ops')).toBe('客户运营')
    expect(byCode.get('legacy-ops')).toBe('旧运营部')
    // A department the backend can no longer name keeps its code as the readable label.
    expect(byCode.get('retired-ops')).toBe('retired-ops')
    expect(options.every(option => option.name !== '' && option.code !== '')).toBe(true)
  })

  it('keeps only department-shared rows and narrows to the chosen code', () => {
    expect(filterByDepartment(rows, '').map(row => row.id)).toEqual([2, 3, 4, 5])
    expect(filterByDepartment(rows, 'crm-ops').map(row => row.id)).toEqual([2, 3])
    // A selection whose department was deleted filters to nothing instead of matching everything.
    expect(filterByDepartment(rows, 'deleted-ops')).toEqual([])
  })

  it('leaves private rows out of every department choice', () => {
    expect(departmentOptionsOf(rows).some(option => option.code === '私有技能')).toBe(false)
    expect(filterByDepartment(rows, '').some(row => row.name === '私有技能')).toBe(false)
  })
})