import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveInvocationAnchor } from '../src/standalone-profile.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plus-anchor-'))
  roots.push(root)
  return root
}

describe('invocation anchor', () => {
  it('follows a bin symlink to the file it points at', () => {
    const root = scratch()
    const target = join(root, 'bin.js')
    const link = join(root, 'dsh-plus')
    execFileSync('touch', [target])
    symlinkSync(target, link)
    // A global npm install is exactly this shape: the shell runs `<prefix>/bin/dsh-plus`,
    // which is a link into the package. Resolving from the link would start at the bin
    // directory and find no node_modules.
    expect(resolveInvocationAnchor(link, target)).toBe(realpath(target))
  })

  it('falls back to this module when node ran without a script path', () => {
    const root = scratch()
    const fallback = join(root, 'module.js')
    execFileSync('touch', [fallback])
    expect(resolveInvocationAnchor(undefined, fallback)).toBe(realpath(fallback))
  })
})

/** A path with its platform separators normalized the way realpath reports it. */
function realpath(path: string): string {
  return execFileSync('realpath', [path], { encoding: 'utf8' }).trim()
}

const bin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))

describe.skipIf(!existsSync(bin))('symlinked command', () => {
  it('runs inspect through a bin link', () => {
    const root = scratch()
    const link = join(root, 'dsh-plus')
    symlinkSync(bin, link)
    const output = execFileSync(process.execPath, [link, 'inspect', '--distribution', fileURLToPath(new URL('..', import.meta.url))], {
      encoding: 'utf8',
    })
    expect(JSON.parse(output).name).toBe('@sparkelf/dsh-plus')
  })
})
