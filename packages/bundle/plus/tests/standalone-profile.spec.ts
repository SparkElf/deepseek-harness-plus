import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { alignReplacedPackageNames, isWithin, resolveDistributionDirectory } from '../src/standalone-profile.ts'

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

describe('alignReplacedPackageNames', () => {
  /**
   * Lay out one replaced package the way an override installs it: our build at the
   * official path, still declaring our name.
   * @param profileModules - the profile's `node_modules` directory.
   * @param entry - the official package directory name.
   * @returns the manifest path.
   */
  function replaced(profileModules: string, entry: string): string {
    const directory = join(profileModules, '@deepseek-ai', entry)
    mkdirSync(directory, { recursive: true })
    const manifest = join(directory, 'package.json')
    writeFileSync(manifest, JSON.stringify({ name: '@sparkelf/' + entry, version: '1.2.3' }, null, 2) + '\n')
    return manifest
  }

  it('makes a replaced package declare the location it occupies', () => {
    // The client module system resolves a loader entry declared name and then requires
    // the manifest it finds to declare that same name. An override installs our build at
    // the official path while the manifest keeps naming our scope, so the package owned
    // no browser module and its panels silently never rendered.
    const root = join(tmpdir(), 'dsh-plus-names-' + String(Math.random()).slice(2))
    roots.push(root)
    const modules = join(root, 'node_modules')
    const manifest = replaced(modules, 'dsh-client-ui-settings-models')
    alignReplacedPackageNames(modules)
    expect(JSON.parse(readFileSync(manifest, 'utf8')).name).toBe('@deepseek-ai/dsh-client-ui-settings-models')
  })

  it('replaces the manifest rather than writing through it', () => {
    // pnpm hard-links a manifest into its content-addressed store. Writing through the
    // link would edit every profile that shares the store entry, so the rewrite must
    // create a new file and move it into place.
    const root = join(tmpdir(), 'dsh-plus-names-' + String(Math.random()).slice(2))
    roots.push(root)
    const modules = join(root, 'node_modules')
    const manifest = replaced(modules, 'dsh-tools')
    const before = statSync(manifest)
    alignReplacedPackageNames(modules)
    const after = statSync(manifest)
    expect(after.ino).not.toBe(before.ino)
    expect(after.nlink).toBe(1)
  })

  it('leaves a package that already declares the right name alone', () => {
    const root = join(tmpdir(), 'dsh-plus-names-' + String(Math.random()).slice(2))
    roots.push(root)
    const modules = join(root, 'node_modules')
    const manifest = replaced(modules, 'dsh-agent-presets')
    writeFileSync(manifest, JSON.stringify({ name: '@deepseek-ai/dsh-agent-presets' }, null, 2) + '\n')
    const before = statSync(manifest)
    alignReplacedPackageNames(modules)
    expect(statSync(manifest).ino).toBe(before.ino)
  })
})

describe('Windows pnpm invocation', () => {
  it('runs pnpm through the shell on Windows', () => {
    // \`spawnSync\` on a \`.cmd\` shim fails with EINVAL: Windows resolves a command name
    // through its shell. The profile install passed 'pnpm.cmd' as the executable and
    // stopped every Windows installation at 'spawnSync pnpm.cmd EINVAL'. The source is
    // read rather than executed because the failure needs Windows to reproduce.
    const source = readFileSync(new URL('../src/standalone-profile.ts', import.meta.url), 'utf8')
    const runner = source.slice(source.indexOf('function runPnpm'))
    expect(runner.slice(0, runner.indexOf('\n}'))).toContain('shell: process.platform === \'win32\'')
  })
})
