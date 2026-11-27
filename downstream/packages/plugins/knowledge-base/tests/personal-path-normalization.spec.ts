import { describe, expect, it } from 'vitest'
import { normalizePersonalWritePath } from '../src/index.ts'
import { scopeForPath } from '../src/ftsIndex.ts'
import { resolveUploadDir } from '../src/client/dropTargetPath.ts'

describe('normalizePersonalWritePath', () => {
  it('prepends the caller to a virtual personal bucket file', () => {
    expect(normalizePersonalWritePath('personal/report.md', 'u1')).toBe('personal/u1/report.md')
  })

  it('prepends the caller to a nested virtual personal folder', () => {
    expect(normalizePersonalWritePath('personal/specs/a.md', 'u1')).toBe('personal/u1/specs/a.md')
  })

  it('keeps an already caller-scoped path unchanged', () => {
    expect(normalizePersonalWritePath('personal/u1/report.md', 'u1')).toBe('personal/u1/report.md')
  })

  it('leaves an explicit other-user path for the permission layer to refuse', () => {
    expect(normalizePersonalWritePath('personal/11111111-1111-4111-8111-111111111111/report.md', 'u1'))
      .toBe('personal/11111111-1111-4111-8111-111111111111/report.md')
  })

  it('does not touch global or department paths', () => {
    expect(normalizePersonalWritePath('global/a.md', 'u1')).toBe('global/a.md')
    expect(normalizePersonalWritePath('department/D1/a.md', 'u1')).toBe('department/D1/a.md')
  })
})

describe('scopeForPath', () => {
  it('reports personal for the caller-scoped path', () => {
    expect(scopeForPath('personal/u1/report.md')).toMatchObject({ scope: 'personal', ownerId: 'u1' })
  })

  it('reports personal for the virtual bucket spelling instead of global', () => {
    expect(scopeForPath('personal/report.md')).toMatchObject({ scope: 'personal', ownerId: null })
  })
})

describe('resolveUploadDir', () => {
  it('maps the virtual personal bucket to the caller subtree', () => {
    expect(resolveUploadDir('personal', 'u1')).toBe('personal/u1')
    expect(resolveUploadDir('personal/specs', 'u1')).toBe('personal/u1/specs')
  })
})
