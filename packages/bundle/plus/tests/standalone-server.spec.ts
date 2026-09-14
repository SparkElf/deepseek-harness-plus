import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { waitForAuthenticatedUrl } from '../src/standalone-server.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Write a launcher log holding one \`dsh web:\` line.
 * @param line - the line to write, or null for an empty log.
 * @returns the log path.
 */
function launcherLog(line: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plus-log-'))
  roots.push(root)
  const path = join(root, 'server.log')
  writeFileSync(path, line === null ? '' : line + String.fromCharCode(10))
  return path
}

describe('waitForAuthenticatedUrl', () => {
  it('returns the URL the launcher printed', async () => {
    // The bare address this command used to report opens on a 401: the server refuses
    // every request without the cookie the launch token mints, and only this line
    // carries that token.
    const expected = 'http://127.0.0.1:3081/?token=abc123'
    const path = launcherLog('dsh web: ' + expected)
    await expect(waitForAuthenticatedUrl(path, 1_000)).resolves.toBe(expected)
  })

  it('finds the line among other launcher output', async () => {
    // The launcher writes progress before the URL, so the line is not the first one.
    const root = mkdtempSync(join(tmpdir(), 'dsh-plus-log-'))
    roots.push(root)
    const path = join(root, 'server.log')
    writeFileSync(path, ['building', 'dsh web: http://127.0.0.1:3099/?token=xyz', 'ready'].join(String.fromCharCode(10)))
    await expect(waitForAuthenticatedUrl(path, 1_000)).resolves.toBe('http://127.0.0.1:3099/?token=xyz')
  })

  it('gives up rather than reporting an address without a token', async () => {
    // Reporting the bare address is the defect: a caller that gets undefined falls back
    // to the unauthenticated URL rather than inventing one, and the timeout stays short
    // because the launcher prints within its own startup.
    const path = launcherLog('dsh web: not a url')
    await expect(waitForAuthenticatedUrl(path, 300)).resolves.toBeUndefined()
  })

  it('waits for a log the launcher has not written yet', async () => {
    // The server answers before the launcher prints, so an absent file is a race with
    // its first write rather than a failure.
    const root = mkdtempSync(join(tmpdir(), 'dsh-plus-log-'))
    roots.push(root)
    await expect(waitForAuthenticatedUrl(join(root, 'absent.log'), 300)).resolves.toBeUndefined()
  })
})
