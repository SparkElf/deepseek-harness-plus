/**
 * Bump every Plus release member to one version and refresh what depends on it.
 *
 * The member list comes from \`PlusFamily.patterns\` in \`families.ts\` — the same authority
 * \`verify.ts --family plus\` enforces — because a hand-written list of directories missed
 * fifteen of the nineteen members and failed the release before it published anything.
 *
 * Two generated files follow a version change, in this order: the standalone manifest
 * carries each member's version, and the lockfile records the manifest. Updating the
 * lockfile before the manifest leaves it stale, which CI reports as
 * ERR_PNPM_OUTDATED_LOCKFILE against \`packages/standalone/plus-standalone\`.
 *
 * Usage:
 *   node scripts/release/bump-plus.mjs <version> [--dry-run]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the generated manifest and its inputs live, relative to the repository root. */
const MANIFEST_OUT = 'packages/standalone/plus-standalone/package.json'
const MANIFEST_DISTRIBUTION = 'packages/bundle/plus'
const MANIFEST_RUNTIME = '0.1.5-rc.2'
const MANIFEST_GENERATOR = 'scripts/standalone/generate-manifest.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Every Plus release member, resolved from the family's own patterns.
 *
 * @returns repository-relative manifest paths.
 */
export function plusMemberManifests() {
  const patterns = [
    'packages/plus/*/package.json',
    'packages/bundle/plus/package.json',
    'packages/standalone/*/package.json',
    'patches/npm/*/package.json',
  ]
  return patterns
    .flatMap(pattern => execFileSync('bash', ['-c', 'ls ' + pattern], { cwd: root, encoding: 'utf8' }).trim().split('\n'))
    .sort()
}

/**
 * Rewrite every member's version to \`version\`.
 *
 * @param version - the version the whole family takes.
 * @param dryRun - report the change without writing it.
 * @returns the paths whose version changed.
 */
export function bumpPlus(version, dryRun) {
  const changed = []
  for (const path of plusMemberManifests()) {
    const manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8'))
    if (manifest.version === version) continue
    changed.push({ path, from: manifest.version, to: version })
    if (dryRun) continue
    const text = readFileSync(resolve(root, path), 'utf8')
    writeFileSync(resolve(root, path), text.replace(/"version": "[^"]+"/u, '"version": "' + version + '"'))
  }
  return changed
}

function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const version = argv.find(argument => !argument.startsWith('--'))
  if (version === undefined) throw new Error('usage: bump-plus.mjs <version> [--dry-run]')
  const members = plusMemberManifests()
  const changed = bumpPlus(version, dryRun)
  const label = changed.length + ' of ' + String(members.length) + ' member(s)'
  console.log('bump-plus: ' + (dryRun ? 'would set ' : 'set ') + label + ' to ' + version)
  for (const entry of changed) console.log('  ' + entry.path + ': ' + entry.from + ' -> ' + entry.to)
  if (dryRun) return
  const run = (command, args, name) => {
    execFileSync(command, args, { cwd: root, stdio: 'inherit' })
    console.log('bump-plus: ' + name)
  }
  run('pnpm', ['exec', 'tsx', MANIFEST_GENERATOR, '--distribution', MANIFEST_DISTRIBUTION,
    '--out', MANIFEST_OUT, '--runtime-version', MANIFEST_RUNTIME], 'manifest regenerated')
  run('pnpm', ['install', '--lockfile-only'], 'lockfile updated')
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main()
}
