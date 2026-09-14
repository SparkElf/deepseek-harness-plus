import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The built executable, not the TypeScript source.
 *
 * A child process launched from outside the repository cannot resolve the \`tsx\`
 * loader that a source launch needs, and a published command never runs from a
 * checkout to begin with. The built file is what an installation actually runs, so
 * that is what these assertions exercise.
 */
const bin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const built = existsSync(bin)

/**
 * Run the built command from one working directory.
 *
 * The working directory is the variable under test: a command installed with
 * \`npm install -g\` must work from anywhere, and the failure it once produced named
 * the working directory rather than the installation.
 * @param cwd - directory to run the command from.
 * @param args - argv after the executable and script name.
 * @returns captured stdout, stderr, and exit status.
 */
function runFrom(cwd: string, args: readonly string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
}

describe.skipIf(!built)('standalone command location independence', () => {
  it('does not read the installation from the working directory', () => {
    // The command resolves @sparkelf/dsh-plus from its own file. When it read
    // process.cwd() instead, every directory but the install root reported that the
    // distribution was "not installed in <cwd>".
    for (const cwd of ['/', '/tmp', fileURLToPath(new URL('../../../..', import.meta.url))]) {
      const result = runFrom(cwd, ['status'])
      expect(result.stderr).not.toContain('run this command from the directory that installed it')
      expect(result.stderr).not.toContain('is not installed in ' + cwd)
    }
  })

  it('reports the distribution from a directory outside the repository', () => {
    // \`status\` answers whether the server runs, which requires resolving the
    // distribution first; reaching that answer proves the resolution succeeded.
    const result = runFrom('/', ['status'])
    expect(result.stdout + result.stderr).toMatch(/Plus is (not running|already running)/u)
  })
})
