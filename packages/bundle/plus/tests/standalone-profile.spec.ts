import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isWithin, resolveDistributionDirectory } from '../src/standalone-profile.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Lay out an installation the way npm does: the distribution nested under the
 * consumer's own \`node_modules\`.
 * @returns the consumer root, holding a \`package.json\` and the nested distribution.
 */
function installedTree(): string {
  const root = join(tmpdir(), 'dsh-plus-anchor-' + String(Math.random()).slice(2))
  roots.push(root)
  const distribution = join(root, 'node_modules', '@sparkelf', 'dsh-plus')
  mkdirSync(distribution, { recursive: true })
  writeFileSync(join(root, 'package.json'), '{' + JSON.stringify('name') + ':' + JSON.stringify('consumer') + '}')
  writeFileSync(join(distribution, 'package.json'), '{' + JSON.stringify('name') + ':' + JSON.stringify('@sparkelf/dsh-plus') + '}')
  return root
}

describe('resolveDistributionDirectory', () => {
  it('accepts a distribution nested under the anchor', () => {
    // The resolved package sits at \`<root>/node_modules/@sparkelf/dsh-plus\`, not beside
    // the anchor, so containment must look downward as well as sideways.
    const root = installedTree()
    expect(resolveDistributionDirectory(join(root, 'package.json'))).toBe(
      join(root, 'node_modules', '@sparkelf', 'dsh-plus'),
    )
  })
})

describe('path containment', () => {
  it('accepts a nested path on this platform', () => {
    expect(isWithin(join('/a', 'b', 'c'), join('/a', 'b'))).toBe(true)
    expect(isWithin(join('/a', 'b'), join('/a', 'b'))).toBe(true)
  })

  it('rejects a path outside the parent', () => {
    expect(isWithin('/a/c', '/a/b')).toBe(false)
    expect(isWithin('/a', '/a/b')).toBe(false)
    // A sibling whose name merely starts with the parent's is not inside it.
    expect(isWithin('/a/bc', '/a/b')).toBe(false)
  })

  it('accepts a nested Windows path', () => {
    // A global install on Windows separates with a backslash. Reading containment as
    // text against a hardcoded \`/\` reported the distribution as sitting outside its own
    // tree, which is the failure every Windows installation hit.
    const parent = win32.join('D:\\', 'software', 'node_modules', '@sparkelf', 'dsh-plus-standalone')
    const nested = win32.join(parent, 'node_modules', '@sparkelf', 'dsh-plus')
    expect(isWithin(nested, parent, 'win32')).toBe(true)
    expect(isWithin(parent, parent, 'win32')).toBe(true)
    // The rejected comparison, kept visible: this is what the check must not do.
    expect(nested.startsWith(parent + '/')).toBe(false)
  })

  it('rejects a Windows path outside the parent', () => {
    const parent = win32.join('D:\\', 'software', 'node_modules', '@sparkelf', 'dsh-plus-standalone')
    expect(isWithin(win32.join('D:\\', 'other'), parent, 'win32')).toBe(false)
    // A sibling whose name starts with the parent's is not inside it.
    expect(isWithin(parent + 'x', parent, 'win32')).toBe(false)
  })
})
