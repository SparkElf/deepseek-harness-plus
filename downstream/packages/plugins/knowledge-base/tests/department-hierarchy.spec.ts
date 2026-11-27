/**
 * The department bucket as a nested organization tree.
 *
 * The bucket used to be one flat folder per department, so a reader in a three-level
 * organization saw one pile of documents with no way to tell a squad's from a
 * detachment's. These pin the layout that replaced it: the view mirrors the caller's
 * reporting line, every level is a real directory, and a backend that does not report
 * the path still produces the old flat shape rather than an empty bucket.
 */
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  bucketOf,
  departmentPrefixMatches,
  syncView,
  usableDepartmentPath,
  viewPathFor,
} from '../src/views.ts'

/** A three-level path, the shape the product brief names. */
const CITY = 'nanning-psb'
const DETACHMENT = 'digital-recon'
const BRIGADE = 'data-combat'
const CHAIN = [CITY, DETACHMENT, BRIGADE]

describe('usable organization path', () => {
  it('accepts an ordinary chain and trims it', () => {
    expect(usableDepartmentPath([' a ', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('answers empty for an absent path, which is what an older backend sends', () => {
    // This is the graceful-degradation contract: no path is not an error, it is the
    // pre-hierarchy shape.
    expect(usableDepartmentPath(undefined)).toEqual([])
    expect(usableDepartmentPath([])).toEqual([])
  })

  it('refuses a chain whose code could not be a directory name', () => {
    // The codes come from another system. One that carries a separator or `..` would
    // place a folder outside the view, so the whole chain is refused rather than the
    // offending level: a partial hierarchy would read as a real one.
    expect(usableDepartmentPath(['ok', '../escape'])).toEqual([])
    expect(usableDepartmentPath(['ok', 'a/b'])).toEqual([])
    expect(usableDepartmentPath(['ok', ''])).toEqual([])
    expect(usableDepartmentPath(['ok', '.'])).toEqual([])
  })
})

describe('depth of the department bucket', () => {
  it('mirrors the whole chain for a nested path', () => {
    expect(bucketOf(`department/${CHAIN.join('/')}/plan.md`, CHAIN)).toEqual({
      bucket: 'department',
      inner: `${CHAIN.join('/')}/plan.md`,
    })
  })

  it('keeps sub-directories below the department folder', () => {
    // A department's own folders must survive: the hierarchy is the reporting line,
    // not a replacement for the folders the department organizes itself in.
    expect(bucketOf(`department/${CHAIN.join('/')}/2026/q1/plan.md`, CHAIN)).toEqual({
      bucket: 'department',
      inner: `${CHAIN.join('/')}/2026/q1/plan.md`,
    })
  })

  it('stays one level deep when no path is reported', () => {
    // An un-upgraded backend must produce exactly the old layout.
    expect(bucketOf('department/OPS/plan.md')).toEqual({ bucket: 'department', inner: 'plan.md' })
    expect(bucketOf('department/OPS/plan.md', [])).toEqual({ bucket: 'department', inner: 'plan.md' })
  })

  it('serves a legacy flat grant even when a path IS reported', () => {
    // Compatibility is per-path: a document created yesterday lives at
    // `department/<own>/file`, and the caller gaining an organization path must not
    // make it unreadable. It is linked at the bucket root, where it always was.
    expect(bucketOf(`department/${BRIGADE}/legacy.md`, CHAIN)).toEqual({
      bucket: 'department',
      inner: 'legacy.md',
    })
  })

  it('refuses a peer department even though it shares the root', () => {
    // The whole point of comparing the full chain: `A/B` and `A/C` share `A`, and a
    // root-only comparison would leak the sibling's documents.
    expect(bucketOf(`department/${CITY}/other-squad/plan.md`, CHAIN)).toBeUndefined()
    expect(bucketOf(`department/${CITY}/plan.md`, CHAIN)).toBeUndefined()
  })

  it('leaves the other two buckets exactly as they were', () => {
    // global and personal are unchanged by this feature, and the path argument must
    // not alter them.
    expect(bucketOf('global/制度.md', CHAIN)).toEqual({ bucket: 'global', inner: '制度.md' })
    expect(bucketOf('personal/u-1/笔记.md', CHAIN)).toEqual({ bucket: 'personal', inner: '笔记.md' })
  })
})

describe('which paths belong to the caller department', () => {
  it('matches the full chain and requires something below it', () => {
    expect(departmentPrefixMatches(`department/${CHAIN.join('/')}/a.md`, BRIGADE, CHAIN)).toBe(true)
    expect(departmentPrefixMatches(`department/${CHAIN.join('/')}/2026/a.md`, BRIGADE, CHAIN)).toBe(true)
    // The container itself is not a document.
    expect(departmentPrefixMatches(`department/${CHAIN.join('/')}`, BRIGADE, CHAIN)).toBe(false)
  })

  it('does not match a peer that shares an ancestor', () => {
    expect(departmentPrefixMatches(`department/${CITY}/other-squad/a.md`, BRIGADE, CHAIN)).toBe(false)
  })

  it('falls back to the single code when no path is reported', () => {
    // Same answers as before this change, which is what keeps an un-upgraded backend
    // working with no version check.
    expect(departmentPrefixMatches('department/OPS/plan.md', 'OPS')).toBe(true)
    expect(departmentPrefixMatches('department/OPS2/plan.md', 'OPS')).toBe(false)
    expect(departmentPrefixMatches('department/OPS/plan.md', undefined)).toBe(false)
    expect(departmentPrefixMatches('global/制度.md', 'OPS')).toBe(false)
  })
})

/** Create a fixture tree and the view settings that go with it. */
async function fixture() {
  const actual = await mkdtemp(join(tmpdir(), 'kb-dept-actual-'))
  const views = await mkdtemp(join(tmpdir(), 'kb-dept-views-'))
  return {
    actual,
    views,
    options: { actualRoot: actual, viewRoot: views, userId: 'u-1' },
    cleanup: async () => {
      await rm(actual, { recursive: true, force: true })
      await rm(views, { recursive: true, force: true })
    },
  }
}

describe('syncing a nested department bucket', () => {
  it('creates every level of the caller chain and links the documents into it', async () => {
    const f = await fixture()
    try {
      const rel = `department/${CHAIN.join('/')}/plan.md`
      await mkdir(dirname(join(f.actual, rel)), { recursive: true })
      await writeFile(join(f.actual, rel), '# plan\n', 'utf8')

      const delta = await syncView({ ...f.options, departmentCode: BRIGADE, departmentPathCodes: CHAIN }, [{ relPath: rel }])
      expect(delta.linked).toEqual([`department/${CHAIN.join('/')}/plan.md`])

      const viewDir = viewPathFor({ ...f.options, departmentCode: BRIGADE, departmentPathCodes: CHAIN })
      // The chain exists as real directories, deepest level included.
      await expect(readdir(join(viewDir, 'department', CITY, DETACHMENT, BRIGADE))).resolves.toEqual(['plan.md'])
    } finally { await f.cleanup() }
  })

  it('keeps an empty level so a department with no documents still reads as existing', async () => {
    const f = await fixture()
    try {
      // No documents at all: the reader must still see their reporting line, otherwise
      // "my department has nothing" is indistinguishable from "my department is gone".
      const delta = await syncView({ ...f.options, departmentCode: BRIGADE, departmentPathCodes: CHAIN }, [])
      expect(delta.linked).toEqual([])
      const viewDir = viewPathFor({ ...f.options, departmentCode: BRIGADE, departmentPathCodes: CHAIN })
      await expect(readdir(join(viewDir, 'department'))).resolves.toEqual([CITY])
      await expect(readdir(join(viewDir, 'department', CITY))).resolves.toEqual([DETACHMENT])
      await expect(readdir(join(viewDir, 'department', CITY, DETACHMENT))).resolves.toEqual([BRIGADE])
    } finally { await f.cleanup() }
  })

  it('does not resurrect the chain on the second sync, so an unchanged set writes nothing', async () => {
    const f = await fixture()
    try {
      const options = { ...f.options, departmentCode: BRIGADE, departmentPathCodes: CHAIN }
      const first = await syncView(options, [])
      expect(first.linked).toEqual([])
      const second = await syncView(options, [])
      // The whole design rests on an unchanged grant set costing no writes.
      expect(second).toEqual({ linked: [], unlinked: [], unchanged: 0, pruned: [] })
    } finally { await f.cleanup() }
  })

  it('drops the nested folder when the grant is revoked', async () => {
    const f = await fixture()
    try {
      const rel = `department/${CHAIN.join('/')}/plan.md`
      await mkdir(dirname(join(f.actual, rel)), { recursive: true })
      await writeFile(join(f.actual, rel), '# plan\n', 'utf8')
      const options = { ...f.options, departmentCode: BRIGADE, departmentPathCodes: CHAIN }

      await syncView(options, [{ relPath: rel }])
      const revoked = await syncView(options, [])
      expect(revoked.unlinked).toEqual([`department/${CHAIN.join('/')}/plan.md`])
      // The file is gone from the view, but the chain itself survives as structure.
      const viewDir = viewPathFor(options)
      expect(await readdir(join(viewDir, 'department', CITY, DETACHMENT, BRIGADE))).toEqual([])
    } finally { await f.cleanup() }
  })

  it('serves a legacy flat document alongside the nested tree', async () => {
    const f = await fixture()
    try {
      // One document from before the upgrade, one in the new layout.
      const legacy = `department/${BRIGADE}/legacy.md`
      const nested = `department/${CHAIN.join('/')}/plan.md`
      for (const rel of [legacy, nested]) {
        await mkdir(dirname(join(f.actual, rel)), { recursive: true })
        await writeFile(join(f.actual, rel), rel, 'utf8')
      }
      const options = { ...f.options, departmentCode: BRIGADE, departmentPathCodes: CHAIN }
      const delta = await syncView(options, [{ relPath: legacy }, { relPath: nested }])

      // Both are visible: the old document did not disappear when the path arrived.
      expect(delta.linked.sort()).toEqual(['department/legacy.md', `department/${CHAIN.join('/')}/plan.md`].sort())
    } finally { await f.cleanup() }
  })

  it('keeps the flat layout when the backend reports no path', async () => {
    const f = await fixture()
    try {
      // Graceful degradation: this is the running deployment today.
      const rel = 'department/OPS/plan.md'
      await mkdir(dirname(join(f.actual, rel)), { recursive: true })
      await writeFile(join(f.actual, rel), '# plan\n', 'utf8')
      const options = { ...f.options, departmentCode: 'OPS' }
      const delta = await syncView(options, [{ relPath: rel }])
      expect(delta.linked).toEqual(['department/plan.md'])
      const viewDir = viewPathFor(options)
      await expect(readdir(join(viewDir, 'department'))).resolves.toEqual(['plan.md'])
    } finally { await f.cleanup() }
  })
})
