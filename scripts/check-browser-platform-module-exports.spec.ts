/** Verify the platform-module export check against the failure it exists to catch.
 *
 * The check is only worth running if it rejects a plugin referencing a name the host bundle does
 * not export. Each case below is a bundle pair written inline, so the detection boundary is
 * exercised without depending on the repository's own build.
 *
 * @module scripts/check-browser-platform-module-exports.spec
 */
import { expect, test } from 'vitest'
// @ts-expect-error The check is runtime JavaScript without declaration artifacts.
import { platformExports, referencedNames, unresolvableReferences } from './check-browser-platform-module-exports.mjs'

/**
 * Filler exports, so a fixture table has the width a real one has (the shipped table carries 287
 * names) rather than matching by accident.
 */
const FILLER = Array.from({ length: 30 }, (_, index) => 'IconFiller' + String(index) + 'Regular')

/** A host bundle carrying a platform module export table with the given members. */
function hostBundleWith(members: string[]) {
  const table = [...members, ...FILLER].map(name => name + ':fn').join(',')
  return 'const gE={' + table + '};const f={"@deepseek-ai/cordis":uf,"@deepseek-ai/dsh-client-ui-primitives":gE}'
}

/** A plugin client bundle binding the platform module to a local alias and reading one member. */
function clientBundleReading(member: string) {
  return 'let p=require("@deepseek-ai/dsh-client-ui-primitives");const x=p.' + member + ';'
}

const TABLE = ['Button', 'Input', 'Modal', 'Tooltip', 'StateDot', 'IconPlusOutlineRegular']

test('a member the host bundle exports resolves', () => {
  const host = hostBundleWith([...TABLE, 'IconSearchOutlineRegular'])
  expect(unresolvableReferences(host, clientBundleReading('IconSearchOutlineRegular'))).toEqual([])
})

test('a member the host bundle omits is reported', () => {
  // The 2026-10-16 regression: the repository's source names the glyph *16, the served host
  // bundle exported *Regular, and the miss surfaced only as React error #130 at runtime.
  const host = hostBundleWith([...TABLE, 'IconSearchOutlineRegular'])
  expect(unresolvableReferences(host, clientBundleReading('IconSearchOutline16')))
    .toEqual(['IconSearchOutline16'])
})

test('a bundle that never references the platform module is not judged', () => {
  const host = hostBundleWith(TABLE)
  expect(unresolvableReferences(host, 'const x=1;')).toEqual([])
})

test('the export table is read from the module factory rather than from the bundle text', () => {
  // A name mentioned only as a reference is not an export: counting it would pass a bundle whose
  // host copy cannot actually resolve it.
  const host = hostBundleWith(TABLE) + 'function use(){return IconSearchOutline16}'
  const exported = platformExports(host)
  expect(exported.has('IconSearchOutlineRegular')).toBe(false)
  expect(exported.has('IconSearchOutline16')).toBe(false)
  expect(exported.has('Button')).toBe(true)
})

test('a host bundle with no recognisable export table throws rather than passing silently', () => {
  expect(() => platformExports('const a=1;')).toThrow()
})

test('references are read from the alias the bundle binds the module to', () => {
  const names = referencedNames('var q=require("@deepseek-ai/dsh-client-ui-primitives");q.Button;q.Modal;')
  expect([...names].sort()).toEqual(['Button', 'Modal'])
})

test('a destructuring require is read as a reference', () => {
  const names = referencedNames('const a=require("@deepseek-ai/dsh-client-ui-primitives").Input;')
  expect([...names]).toEqual(['Input'])
})
