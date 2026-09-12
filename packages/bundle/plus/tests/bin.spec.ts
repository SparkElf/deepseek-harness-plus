import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

/**
 * Run the real dispatcher in a child process and return what it printed.
 *
 * The dispatcher chooses between two command families, and a dispatch that forwards
 * the wrong argv slice still exits cleanly while the callee reports a usage error —
 * so these assertions read the message rather than the exit code alone.
 * @param args - argv after the executable and script name.
 * @returns captured stdout, stderr, and exit status.
 */
function runBin(args: readonly string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', bin, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
}

describe('Plus executable dispatch', () => {
  it('forwards the command word to apply, which parses it itself', () => {
    // `apply` receives the full argv including its own name. Handing it a slice that
    // dropped the word makes it reject every invocation with a usage error, which is
    // what a source-based installation runs first.
    const result = runBin(['apply', '--dsh-root', '/nonexistent-official-root'])
    expect(result.stderr).not.toContain('usage: dsh-plus apply')
    expect(result.stderr).not.toMatch(/^\s*$/u)
  })

  it('treats a word other than apply as a lifecycle command', () => {
    const result = runBin(['definitely-not-a-command'])
    expect(result.stderr).toContain('unknown command')
    expect(result.status).toBe(1)
  })
})
