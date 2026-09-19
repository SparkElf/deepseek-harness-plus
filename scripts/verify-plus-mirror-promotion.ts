/**
 * Fail a mirror promotion that would discard a local change no patch reproduces.
 *
 * The runtime mirror is a checkout the deployment serves, and a promotion rebuilds it with
 * \`dsh-plus apply\`: reset the tree, then reapply the declared patch set. Any uncommitted
 * change the patch set does not cover is therefore deleted by the promotion. That is not
 * hypothetical — four WSL path-translation files were lost this way when 3080 moved to
 * 0.1.6-alpha.1, and the served page showed a red failure toast and a blank icon.
 *
 * The check answers one question per uncommitted file: does some declared patch's payload
 * touch this path? A file that exists in the repository does not count — the mirror is
 * rebuilt from patch payloads, so only a patch reproduces a change into it.
 *
 * Usage:
 *   tsx scripts/verify-plus-mirror-promotion.ts --mirror <path> [--patches <path>]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const defaultPatchRoot = resolve(root, 'patches/npm')

/** Paths git reports as modified, staged, or untracked, excluding build output. */
function localChanges(mirror: string): string[] {
  const output = execFileSync('git', ['status', '--porcelain'], { cwd: mirror, encoding: 'utf8' })
  const paths: string[] = []
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue
    const path = line.slice(3).trim()
    if (path === '' || path.startsWith('profile/') || path.startsWith('node_modules/')) continue
    if (path.endsWith('pnpm-lock.yaml') || path.endsWith('package-lock.json')) continue
    paths.push(path)
  }
  return paths
}

/** Every repository path any patch payload touches. */
function patchedPaths(patchRoot: string): Set<string> {
  const paths = new Set<string>()
  for (const entry of readdirSync(patchRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const patchesDirectory = resolve(patchRoot, entry.name, 'patches')
    if (!existsSync(patchesDirectory)) continue
    for (const file of readdirSync(patchesDirectory)) {
      if (!file.endsWith('.patch')) continue
      const payload = readFileSync(resolve(patchesDirectory, file), 'utf8')
      // Not anchored to line start: a payload may omit the newline after its last hunk
      // header, which fuses the next 'diff --git' onto that line. Measured — one shipped
      // patch carries three file headers and only the first begins a line.
      for (const match of payload.matchAll(/diff --git a\/(\S+)/gu)) {
        if (match[1] !== undefined) paths.add(match[1])
      }
    }
  }
  return paths
}

function main(): void {
  const argv = process.argv.slice(2)
  const mirrorIndex = argv.indexOf('--mirror')
  if (mirrorIndex < 0 || argv[mirrorIndex + 1] === undefined) {
    throw new Error('usage: verify-plus-mirror-promotion --mirror <path> [--patches <path>]')
  }
  const mirrorArgument = argv[mirrorIndex + 1]
  if (mirrorArgument === undefined) throw new Error('--mirror requires a path')
  const mirror = resolve(mirrorArgument)
  const patchesIndex = argv.indexOf('--patches')
  const patchesArgument = argv[patchesIndex + 1]
  if (patchesIndex >= 0 && patchesArgument === undefined) throw new Error('--patches requires a path')
  const patchRoot = patchesArgument === undefined ? defaultPatchRoot : resolve(patchesArgument)

  const changes = localChanges(mirror)
  const covered = patchedPaths(patchRoot)
  const orphaned = changes.filter(path => !covered.has(path))

  if (orphaned.length > 0) {
    console.error('verify-plus-mirror-promotion: ' + String(orphaned.length) + ' local change(s) no patch reproduces:')
    for (const path of orphaned) console.error('  ' + path)
    console.error('')
    console.error('A promotion resets this mirror and reapplies the patch set, so each of these will be deleted.')
    console.error('Convert each into a patch package before promoting, or revert it.')
    process.exitCode = 1
    return
  }
  console.info('verify-plus-mirror-promotion: all ' + String(changes.length) + ' local change(s) have a patch')
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) main()
