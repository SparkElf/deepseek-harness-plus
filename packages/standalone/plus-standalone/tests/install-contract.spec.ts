/**
 * The standalone package's install contract.
 *
 * A user installs this package and expects the command its README names, so the
 * manifest has to declare one. npm creates a command only for the package that
 * declares \`bin\`: a dependency's executable lands in a nested directory the shell
 * cannot reach, which is how the published rc.28 shipped without \`dsh-plus\` at all.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  bin?: Record<string, string>
  files?: string[]
  dependencies?: Record<string, string>
}

describe('standalone install contract', () => {
  it('declares the command its README tells the user to run', () => {
    // Without this the global install creates no executable and every documented
    // command fails with "not recognized".
    expect(manifest.bin).toBeDefined()
    expect(manifest.bin?.['dsh-plus']).toBe('lib/bin.js')
  })

  it('ships the declared command in the published payload', () => {
    // \`files\` decides what npm packs; a bin outside it resolves to nothing.
    const covered = manifest.files?.some(pattern => pattern.startsWith('lib/')) ?? false
    expect(covered).toBe(true)
  })

  it('depends on the package that owns the CLI implementation', () => {
    // The forwarding entry resolves this dependency; dropping it breaks the command.
    expect(manifest.dependencies?.['@sparkelf/dsh-plus']).toBeDefined()
  })

  it('declares a CLI that the implementation actually provides', () => {
    // The forwarder reads this field to find the executable.
    const dependency = JSON.parse(
      readFileSync(join(root, '..', '..', 'bundle', 'plus', 'package.json'), 'utf8'),
    ) as { bin?: Record<string, string> }
    expect(dependency.bin?.['dsh-plus']).toBe('lib/bin.js')
  })
})
