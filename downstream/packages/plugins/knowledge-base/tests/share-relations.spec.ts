/**
 * 共享 Tab 的两块分组与命名。
 *
 * 这一层守的是「不编数据」这条约束：数据里没有分享者（后端 toSummary 不返回，
 * 表也没有 created_by 列），所以分组只能表达**方向**，不能表达「谁授给了谁」。
 * 用例把这条写死，防止以后有人为了填满一列而发明一个字段。
 */
import { describe, expect, it } from 'vitest'
import {
  isOwnGrant,
  mergeShareRows,
  shareRelationText,
  splitShareRelations,
  type PrincipalNameOf,
  type ShareGrant,
} from '../src/client/shareRelations.ts'

/** A lookup that knows these principals and nothing else. */
const names: PrincipalNameOf = (kind, id) => {
  const table: Record<string, string> = {
    'user:u-me': '我',
    'user:u-zhang': '张三',
    'department:dev': '研发部',
    'role:admin': '管理员',
  }
  return table[`${kind}:${id}`]
}

/** One grant naming a principal. */
const grant = (over: Partial<ShareGrant> = {}): ShareGrant => ({
  id: 'g1',
  relPath: 'global/a.md',
  kind: 'file',
  principalType: 'user',
  principalId: 'u-me',
  action: 'read',
  ...over,
})

describe('the split reads direction, never a grantor', () => {
  it('puts a grant naming the caller in the received group', () => {
    const { received, given } = splitShareRelations([grant()], 'u-me', names)
    expect(received).toHaveLength(1)
    expect(given).toHaveLength(0)
    // The audience is the caller themselves -- which is what "shared with me" means.
    expect(received[0].audience).toBe('我')
  })

  it('puts every other grant in the given group', () => {
    const { received, given } = splitShareRelations(
      [grant({ id: 'g2', principalType: 'department', principalId: 'dev' })],
      'u-me',
      names,
    )
    expect(received).toHaveLength(0)
    expect(given).toHaveLength(1)
    expect(given[0].audience).toBe('研发部')
  })

  it('never invents a sharer field', () => {
    // The row shape deliberately has no `sharedBy`/`grantor`. A field that always says
    // "unknown" is worse than a column that is not there.
    const { received, given } = splitShareRelations([grant()], 'u-me', names)
    for (const row of [...received, ...given]) {
      expect(Object.keys(row)).not.toContain('grantor')
      expect(Object.keys(row)).not.toContain('sharedBy')
      expect(Object.keys(row)).not.toContain('grantedBy')
    }
  })

  it('treats a role or department grant as outgoing, not personal', () => {
    // A department-wide grant is an audience, not "me": counting it as received would
    // make one share look like a personal one.
    const { received, given } = splitShareRelations(
      [
        grant({ id: 'r1', principalType: 'role', principalId: 'admin' }),
        grant({ id: 'd1', principalType: 'department', principalId: 'dev' }),
      ],
      'u-me',
      names,
    )
    expect(received).toHaveLength(0)
    expect(given).toHaveLength(2)
  })

  it('handles an unknown caller without crashing or mis-grouping', () => {
    // No caller id means no grant can be proven to name them, so everything is
    // outgoing -- the conservative direction, because claiming "shared with me" would
    // otherwise show the reader other people's grants as their own.
    const { received, given } = splitShareRelations([grant()], undefined, names)
    expect(received).toHaveLength(0)
    expect(given).toHaveLength(1)
  })

  it('excludes a grant from both groups only when it genuinely belongs to one', () => {
    // One grant appears in exactly one group; a document cannot read as both given and
    // received at the same time.
    const { received, given } = splitShareRelations(
      [grant({ id: 'a' }), grant({ id: 'b', principalId: 'u-zhang' })],
      'u-me',
      names,
    )
    const ids = [...received, ...given].map(row => row.id)
    expect(ids).toEqual(['a', 'b'])
    expect(received.map(r => r.id)).toEqual(['a'])
    expect(given.map(r => r.id)).toEqual(['b'])
  })
})

describe('an audience name falls back to its real id, not to a placeholder', () => {
  it('prefers the resolved display name', () => {
    const { given } = splitShareRelations(
      [grant({ principalType: 'user', principalId: 'u-zhang' })],
      'u-me',
      names,
    )
    expect(given[0].audience).toBe('张三')
  })

  it('prints the raw id when the directory has no entry', () => {
    // The id names a real principal; a word like "unknown" would say nothing while the
    // id at least identifies who holds the grant.
    const { given } = splitShareRelations(
      [grant({ principalType: 'user', principalId: 'u-missing' })],
      'u-me',
      names,
    )
    expect(given[0].audience).toBe('u-missing')
  })

  it('does not blank a row whose directory lookup returns an empty string', () => {
    const blank: PrincipalNameOf = () => ''
    const { given } = splitShareRelations([grant({ principalId: 'u-x' })], 'u-me', blank)
    expect(given[0].audience).toBe('u-x')
  })
})

describe('a row carries the location and name the table renders', () => {
  it('splits the path into a name and a directory', () => {
    const { received } = splitShareRelations([grant({ relPath: 'department/dev/x.md' })], 'u-me', names)
    expect(received[0].name).toBe('x.md')
    expect(received[0].location).toBe('department/dev')
  })

  it('shows a dash for a root-level file', () => {
    const { received } = splitShareRelations([grant({ relPath: 'a.md' })], 'u-me', names)
    expect(received[0].location).toBe('—')
  })
})

describe('isOwnGrant is narrow on purpose', () => {
  it('only a user grant can name the caller', () => {
    expect(isOwnGrant(grant(), 'u-me')).toBe(true)
    expect(isOwnGrant(grant({ principalType: 'department', principalId: 'u-me' }), 'u-me')).toBe(false)
  })

  it('a missing caller id never matches', () => {
    expect(isOwnGrant(grant(), undefined)).toBe(false)
    expect(isOwnGrant(grant(), '')).toBe(false)
  })
})

describe('one table holds both directions', () => {
  it('merges inbound before outbound and keeps every row', () => {
    const split = splitShareRelations(
      [
        grant({ id: 'in-1' }),
        grant({ id: 'out-1', principalId: 'u-zhang' }),
        grant({ id: 'in-2' }),
      ],
      'u-me',
      names,
    )
    const merged = mergeShareRows(split)
    // Inbound first: that is the question this tab answers most often.
    expect(merged.map(r => r.id)).toEqual(['in-1', 'in-2', 'out-1'])
    // Nothing is lost by merging, which is the whole point of one table.
    expect(merged).toHaveLength(3)
  })

  it('carries the direction on each row, not in the table that drew it', () => {
    // This is why the merged table can still state a direction per row.
    const split = splitShareRelations(
      [grant({ id: 'in-1' }), grant({ id: 'out-1', principalId: 'u-zhang' })],
      'u-me',
      names,
    )
    const merged = mergeShareRows(split)
    expect(merged.find(r => r.id === 'in-1')?.direction).toBe('received')
    expect(merged.find(r => r.id === 'out-1')?.direction).toBe('given')
  })

  it('is empty for an empty grant list, so the tab can show one empty state', () => {
    expect(mergeShareRows(splitShareRelations([], 'u-me', names))).toEqual([])
  })
})

describe('the relation column says only what the data supports', () => {
  const base = {
    id: 'r', relPath: 'global/a.md', name: 'a.md', location: 'global',
    principalType: 'user' as const, audience: '张三', action: 'read',
  }

  it('interpolates the audience for an outbound share', () => {
    expect(shareRelationText(
      { ...base, direction: 'given' },
      'From resource owner',
      'Me → {audience}',
    )).toBe('Me → 张三')
  })

  it('uses the fixed phrase for an inbound share, never an interpolated sharer', () => {
    // The grant data has no grantor; "张三点 → 我" would be a fabrication.
    expect(shareRelationText(
      { ...base, direction: 'received' },
      'From resource owner',
      'Me → {audience}',
    )).toBe('From resource owner')
  })
})
