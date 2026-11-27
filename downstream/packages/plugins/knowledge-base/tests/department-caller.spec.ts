/**
 * The caller's organization path, and what happens when the backend does not send one.
 *
 * The running DataOps backend reports only `department.code`/`name` today. The nested
 * bucket is built from `pathCodes`/`pathNames`, so the plugin has to work with a
 * backend that predates them: an absent path must degrade to the single-level layout
 * that shipped before, never to an empty bucket or a thrown error.
 *
 * These pin the parsing boundary, which is where that degradation is decided.
 */
import { describe, expect, it } from 'vitest'
import { readDepartmentOf } from '../src/index.ts'

describe('reading the department profile', () => {
  it('reads code and name from a backend that reports no path', () => {
    // Exactly what the deployed backend answers today.
    expect(readDepartmentOf({ code: 'data-platform', name: '数据平台' })).toEqual({
      code: 'data-platform',
      name: '数据平台',
    })
  })

  it('reads the path when both arrays agree and end at the caller department', () => {
    const department = readDepartmentOf({
      code: 'biz-analysis',
      name: '经营分析',
      pathCodes: ['business-ops', 'biz-analysis'],
      pathNames: ['业务运营中心', '经营分析'],
    })
    expect(department?.pathCodes).toEqual(['business-ops', 'biz-analysis'])
    expect(department?.pathNames).toEqual(['业务运营中心', '经营分析'])
  })

  it('drops a path whose leaf is not the reported department', () => {
    // A profile that contradicts itself: using the path would nest the caller's
    // documents under a department the profile does not name as theirs.
    const department = readDepartmentOf({
      code: 'biz-analysis',
      name: '经营分析',
      pathCodes: ['business-ops', 'crm-ops'],
      pathNames: ['业务运营中心', '客户运营'],
    })
    expect(department).toEqual({ code: 'biz-analysis', name: '经营分析' })
  })

  it('drops a path whose two arrays disagree in length', () => {
    // Codes and names are index-aligned; a mismatch would label a folder with another
    // department's name.
    const department = readDepartmentOf({
      code: 'biz-analysis',
      name: '经营分析',
      pathCodes: ['business-ops', 'biz-analysis'],
      pathNames: ['业务运营中心'],
    })
    expect(department?.pathCodes).toBeUndefined()
  })

  it('drops a path carrying an unusable entry rather than half of one', () => {
    // The whole array is refused: a partially usable chain would render a hierarchy
    // with a level silently missing, which reads as real structure.
    for (const bad of [{ pathCodes: ['ok', ''], pathNames: ['ok', 'name'] },
      { pathCodes: ['ok', 42], pathNames: ['ok', 'name'] },
      { pathCodes: 'not-an-array', pathNames: ['x'] },
      { pathCodes: ['ok'], pathNames: ['ok', 'extra'] }]) {
      const department = readDepartmentOf({ code: 'ok', name: 'OK', ...bad })
      expect(department?.pathCodes).toBeUndefined()
    }
  })

  it('trims the entries so a stray space cannot become part of a folder name', () => {
    const department = readDepartmentOf({
      code: 'biz-analysis',
      name: '经营分析',
      pathCodes: [' business-ops ', ' biz-analysis '],
      pathNames: [' 业务运营中心 ', ' 经营分析 '],
    })
    expect(department?.pathCodes).toEqual(['business-ops', 'biz-analysis'])
    expect(department?.pathNames).toEqual(['业务运营中心', '经营分析'])
  })

  it('still answers undefined for a profile with no department at all', () => {
    expect(readDepartmentOf(undefined)).toBeUndefined()
    expect(readDepartmentOf({})).toBeUndefined()
    expect(readDepartmentOf({ code: '   ' })).toBeUndefined()
  })

  it('falls back to the code as the name when the name is blank', () => {
    // Existing behaviour, kept because the bucket label comes from this pair.
    expect(readDepartmentOf({ code: 'ops' })?.name).toBe('ops')
  })
})
