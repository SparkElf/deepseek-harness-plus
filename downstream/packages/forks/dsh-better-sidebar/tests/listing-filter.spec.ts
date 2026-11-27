/**
 * The name-matching rule set shared by the explorer tree and the knowledge listing.
 *
 * One implementation, two surfaces: these tests are the contract both rely on. The rules
 * that are easy to get wrong are case folding, substring vs prefix, and — most of all —
 * keeping a hit reachable from the root.
 */
import { describe, expect, it } from 'vitest'
import {
  filterLevel,
  nameMatches,
  normaliseNeedle,
  type ChildrenOf,
  type FilterableEntry,
} from '../src/client/listing-filter.ts'

/** One file row. */
const file = (name: string): FilterableEntry => ({ name, isDir: false })
/** One directory row. */
const dir = (name: string): FilterableEntry => ({ name, isDir: true })
/** A children resolver over a plain record keyed by directory NAME. */
const kids = (map: Record<string, readonly FilterableEntry[]>): ChildrenOf<FilterableEntry> =>
  entry => map[entry.name]

describe('matching', () => {
  it('matches a substring, not just a prefix', () => {
    expect(nameMatches('quarterly-report.xlsx', 'xlsx')).toBe(true)
    expect(nameMatches('quarterly-report.xlsx', 'report')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(nameMatches('Report.XLSX', 'xlsx')).toBe(true)
    expect(nameMatches('report.xlsx', 'REPORT')).toBe(true)
  })

  it('folds the needle itself, so a caller that forgot to normalise still matches', () => {
    // A silent "nothing matches" for every uppercase term reads as a broken filter.
    expect(nameMatches('report.xlsx', 'REPORT')).toBe(true)
  })

  it('trims, because a trailing space is invisible', () => {
    expect(normaliseNeedle('  report  ')).toBe('report')
  })

  it('matches everything when the term is empty', () => {
    // Clearing the field must restore the tree, not empty it.
    expect(nameMatches('anything.md', '')).toBe(true)
    expect(filterLevel([file('a.md'), file('b.md')], kids({}), '')).toHaveLength(2)
  })
})

describe('only matching rows survive', () => {
  it('drops the files that do not match, keeping the order', () => {
    const rows = [file('c.xlsx'), file('a.xlsx'), file('b.md')]
    expect(filterLevel(rows, kids({}), 'xlsx').map(row => row.name)).toEqual(['c.xlsx', 'a.xlsx'])
  })

  it('answers an empty level when nothing matches', () => {
    expect(filterLevel([file('a.md')], kids({}), 'zzz')).toEqual([])
  })
})

describe('a hit stays reachable from the root', () => {
  it('keeps the parent chain of a nested hit', () => {
    const inner = [file('report.xlsx')]
    const kept = filterLevel([dir('department')], kids({ department: inner }), 'xlsx')
    expect(kept.map(row => row.name)).toEqual(['department'])
  })

  it('shows a directory\'s contents when its own name matched', () => {
    const inner = [file('anything.md')]
    const children = kids({ finance: inner })
    expect(filterLevel([dir('finance')], children, 'finance').map(row => row.name)).toEqual(['finance'])
    // `withinMatch` is what keeps the descendants of a matched folder.
    expect(filterLevel(inner, children, 'finance', true)).toHaveLength(1)
  })

  it('drops a directory whose subtree has no hit and whose name does not match', () => {
    expect(filterLevel([dir('finance')], kids({ finance: [file('anything.md')] }), 'xlsx')).toEqual([])
  })

  it('judges an unread directory on its own name only', () => {
    // `undefined` children means "not loaded", NOT "empty": the row must not be dropped
    // merely because its contents have never been fetched.
    expect(filterLevel([dir('reports')], kids({}), 'report')).toHaveLength(1)
    expect(filterLevel([dir('other')], kids({}), 'report')).toEqual([])
  })
})
