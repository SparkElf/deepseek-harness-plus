import { describe, expect, it } from 'vitest'
import { clampActiveIndex, filterComboboxOptions, ownerDisplay } from '../src/client/combobox.ts'

const options = [
  { value: 'crm', label: '客户运营', hint: 'crm-ops' },
  { value: 'biz', label: '经营分析', hint: 'biz-analysis' },
  { value: 'global', label: '全局' },
]

describe('permission-centre combobox', () => {
  it('filters by name or code and keeps the selected option list stable', () => {
    expect(filterComboboxOptions(options, '客户').map(option => option.value)).toEqual(['crm'])
    expect(filterComboboxOptions(options, 'biz').map(option => option.value)).toEqual(['biz'])
    expect(filterComboboxOptions(options, '')).toHaveLength(3)
    expect(filterComboboxOptions(options, 'missing')).toEqual([])
  })

  it('clamps keyboard navigation, including an empty list', () => {
    expect(clampActiveIndex(-2, 3)).toBe(0)
    expect(clampActiveIndex(9, 3)).toBe(2)
    expect(clampActiveIndex(2, 0)).toBe(0)
  })

  it('falls back to a dash, never the owner id', () => {
    expect(ownerDisplay('部门管理员')).toBe('部门管理员')
    expect(ownerDisplay(undefined)).toBe('—')
    expect(ownerDisplay('   ')).toBe('—')
    expect(ownerDisplay(null)).toBe('—')
  })
})
