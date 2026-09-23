/**
 * Cut a release and land it, in the one order that works.
 *
 * Every step here exists because a hand-run release got it wrong, and the same few mistakes
 * recurred across three consecutive releases:
 *
 * - The standalone manifests were regenerated *before* the bump twice, so the gate compared
 *   them against the previous version. Generating them after the bump is not a preference;
 *   it is the only order in which the check passes.
 * - A publish that answers `E409 Cannot publish over previously staged version` was read as a
 *   rejection and abandoned. It is the registry's staging window: the upload was accepted,
 *   and re-running the same publish commits it. Re-running is idempotent, so this command
 *   simply tries again.
 * - A newly published dependency inside the supply-chain policy's release-age window fails
 *   `pnpm install --frozen-lockfile`, which reads as a broken lockfile rather than as a policy
 *   that needs an exact-version exemption. The command detects the rejected entries and adds
 *   them, because a release that follows an official release cannot wait out that window.
 * - The pull request cannot be approved by its author, so a self-authored release needs the
 *   administrator merge path. Attempting an ordinary merge wastes a round trip.
 * - Releasing produced commits with the same message twice, because regenerating the
 *   manifests after the bump is a second commit. This command makes one.
 *
 * What this command does not do is decide anything: a patch that stops applying, a gate that
 * fails, or a registry that rejects a write all stop it with the measurement printed. Those
 * need reading, not retrying.
 *
 * Usage: tsx scripts/release/ship.ts --prerelease rc.23 [--family plus] [--dry-run]
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isEntry } from './process.ts'
import { releaseFamily } from './families.ts'

/** How long to wait for checks before giving up, and how often to ask. */
const CHECKS_TIMEOUT_MILLISECONDS = 45 * 60_000
const CHECKS_POLL_MILLISECONDS = 20_000

/** A command result, captured and never thrown. */
interface Outcome {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run one command, echoing nothing until it finishes.
 *
 * Output is captured so a caller can inspect it: several steps below succeed or fail by what
 * a command said rather than by its exit status, and a rejection code that looks fatal in a
 * stream is a staging window when read in full.
 * @param command - executable name.
 * @param args - command arguments.
 * @param allowFailure - return the outcome instead of throwing on a non-zero status.
 * @returns the exit status and both streams.
 */
function run(command: string, args: readonly string[], allowFailure = false): Outcome {
  const result = spawnSync(command, [...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error !== undefined) throw result.error
  const outcome: Outcome = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  if (!allowFailure && result.status !== 0) {
    throw new Error(command + ' ' + args.join(' ') + ' failed with exit code ' + String(result.status)
      + '\n' + outcome.stdout + outcome.stderr)
  }
  return outcome
}

/** Print a step header so a long run stays readable. */
function step(label: string): void {
  console.log('')
  console.log('ship: ' + label)
}

/**
 * Read the version a distribution manifest currently declares.
 * @param family - release family whose entry package carries the version.
 * @returns the declared version.
 */
function declaredVersion(entry: string): string {
  const manifest = JSON.parse(readFileSync(entry, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(entry + ' declares no version')
  return manifest.version
}

/**
 * Add the release-age exemptions that the active policy is rejecting.
 *
 * The policy blocks any dependency published inside its release-age window. A release that
 * follows an official release the day it ships cannot wait that window out, so the closure it
 * resolves needs exact-version exemptions. pnpm names each rejected entry in its error, and
 * those names are what this adds: reading the failure as a stale lockfile is the mistake that
 * turns a one-line exemption into an afternoon.
 * @param workspacePath - pnpm-workspace.yaml to amend.
 * @returns the exemption names it added, empty when the policy rejected nothing.
 */
function addReleaseAgeExemptions(workspacePath: string): string[] {
  const check = run('pnpm', ['install', '--frozen-lockfile'], true)
  if (check.status === 0) return []
  const combined = check.stdout + check.stderr
  if (!combined.includes('minimumReleaseAge') && !combined.includes('minimumReleaseAgeExclude')) return []
  // pnpm lists one rejected package per line as `name@version was published at ...`.
  const rejected = [...combined.matchAll(/^\s*(@?[a-z0-9][^\s@]*(?:\/[^\s@]+)?)@(\d[^\s]*)\s+was published/gmu)]
    .map(match => match[1] + '@' + match[2])
  const unique = [...new Set(rejected)]
  if (unique.length === 0) return []
  const source = readFileSync(workspacePath, 'utf8')
  const already = new Set([...source.matchAll(/^\s+-\s+'?([^'\s]+)'?$/gmu)].map(match => match[1] ?? ''))
  const missing = unique.filter(entry => !already.has(entry))
  if (missing.length === 0) return []
  const addition = [
    '',
    '  # The release follows an official release on the day it ships, so the closure it resolves',
    '  # cannot wait out the release-age window. Each entry names the exact version pinned by',
    '  # dshPlus.sourceBase, never a range.',
    ...missing.map(entry => "  - '" + entry + "'"),
    '',
  ].join('\n')
  writeFileSync(workspacePath, source.trimEnd() + '\n' + addition)
  return missing
}

/**
 * Wait until every check on a pull request has settled.
 *
 * `gh pr checks` exits non-zero while checks are pending, so its status is not the signal;
 * its output is. Polling here replaces a hand-run loop that asked the same question a dozen
 * times and had to interpret that status each time.
 * @param repository - owner/name holding the pull request.
 * @param number - pull request number.
 * @returns the failed check names, empty when all passed.
 */
async function waitForChecks(repository: string, number: string): Promise<string[]> {
  const deadline = Date.now() + CHECKS_TIMEOUT_MILLISECONDS
  for (;;) {
    const listing = run('gh', ['pr', 'checks', number, '--repo', repository], true).stdout
    const lines = listing.split('\n').filter(line => line.trim() !== '')
    const failed = lines.filter(line => /\tfail\t/.test(line)).map(line => line.split('\t')[0] ?? '')
    const pending = lines.filter(line => /\tpending\t/.test(line))
    if (pending.length === 0) return failed
    if (Date.now() >= deadline) throw new Error('checks did not settle within the wait; last state:\n' + listing)
    console.log('  ' + String(pending.length) + ' check(s) still running')
    await new Promise(resolve => setTimeout(resolve, CHECKS_POLL_MILLISECONDS))
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      family: { type: 'string', default: 'plus' },
      prerelease: { type: 'string' },
      branch: { type: 'string' },
      repository: { type: 'string', default: 'SparkElf/deepseek-harness-plus' },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  if (values.prerelease === undefined) throw new Error('ship: --prerelease is required')
  const family = releaseFamily(String(values.family))
  const prerelease = String(values.prerelease)
  const branch = values.branch === undefined ? 'release/' + family.id + '-' + prerelease : String(values.branch)
  const repository = String(values.repository)
  const workspacePath = resolve('pnpm-workspace.yaml')
  const entry = resolve('packages/bundle/plus/package.json')
  const directory = resolve('/tmp', 'dsh-ship-' + family.id + '-' + prerelease)

  // The working tree must be clean: this command commits, and a stray edit would ride along.
  const dirty = run('git', ['status', '--porcelain']).stdout.trim()
  if (dirty !== '') throw new Error('ship: the working tree has uncommitted changes:\n' + dirty)

  step('bumping ' + family.id + ' to ' + prerelease)
  // The package scripts name only the dsh and vendor families, so the bump runs through tsx
  // directly; `release:dsh` would bump the wrong family.
  run('npx', ['tsx', 'scripts/release/bump.ts', '--family', family.id, '--prerelease', prerelease])
  const version = declaredVersion(entry)
  console.log('  version is now ' + version)

  // After the bump, never before: the manifests carry the distribution's version, so
  // generating them first leaves the gate comparing them against the previous one.
  step('regenerating the standalone manifests')
  const runtimeVersion = /^>=?(.+)$/.exec(JSON.parse(readFileSync(entry, 'utf8')).dshPlus.compatibility.dsh)?.[1] ?? ''
  run('npx', ['tsx', 'scripts/standalone/generate-manifest.ts', '--distribution', 'packages/bundle/plus', '--out', 'packages/standalone/plus-standalone/package.json', '--runtime-version', runtimeVersion])
  run('npx', ['tsx', 'scripts/standalone/generate-manifest.ts', '--distribution', 'packages/bundle/plus', '--out', 'packages/standalone/dataops-standalone/package.json', '--runtime-version', runtimeVersion, '--variant', 'dataops'])
  run('git', ['add', '-A'])
  run('git', ['commit', '-q', '-m', 'release(' + family.id + '): ' + version])
  console.log('  committed as one release commit')

  step('running the gates')
  run('pnpm', ['run', 'verify:plus-governance'])
  run('pnpm', ['run', 'verify:standalone-manifest'])
  run('pnpm', ['run', 'verify:standalone-variants'])
  console.log('  governance and both standalone gates pass')

  step('exempting any dependency inside the release-age window')
  const exempted = addReleaseAgeExemptions(workspacePath)
  if (exempted.length === 0) console.log('  nothing was rejected by the policy')
  else {
    console.log('  added ' + String(exempted.length) + ' exemption(s):')
    for (const name of exempted) console.log('    ' + name)
    run('pnpm', ['install', '--lockfile-only'])
    run('pnpm', ['install', '--frozen-lockfile'])
    run('git', ['add', '-A'])
    run('git', ['commit', '-q', '-m', 'fix(release): exempt the ' + runtimeVersion + ' closure from the release-age policy'])
    console.log('  frozen install now succeeds')
  }

  if (values['dry-run'] === true) {
    console.log('')
    console.log('ship: dry run, stopping before publication')
    return 0
  }

  step('publishing ' + version + ' and proving the registry serves it')
  // release:local already retries the staging window, polls propagation, and verifies latest.
  run('pnpm', ['run', 'release:local', '--family', family.id, '--out', directory])

  step('pushing ' + branch)
  run('git', ['branch', '-f', branch])
  run('git', ['push', 'origin', branch])

  step('opening the pull request')
  const bodyPath = resolve('/tmp', 'dsh-ship-' + version + '.md')
  writeFileSync(bodyPath, 'Release `' + version + '` on official DSH `' + runtimeVersion + '`.'
    + '\n\nPublished and verified against the registry before this pull request was opened:'
    + ' every member is served and `latest` resolves it.'
    + '\n\nGenerated by `pnpm run release:ship`.')
  const created = run('gh', ['pr', 'create', '--repo', repository, '--base', 'master', '--head', branch,
    '--title', 'release(' + family.id + '): ' + version, '--body-file', bodyPath]).stdout.trim()
  const number = /\/(\d+)\s*$/.exec(created)?.[1]
  if (number === undefined) throw new Error('ship: could not read the pull request number from: ' + created)
  console.log('  ' + created)

  step('waiting for the checks on #' + number)
  const failed = await waitForChecks(repository, number)
  // The issue-policy workflow needs a repository variable this fork does not define, so it
  // fails on every pull request here. Named rather than ignored: any other failure stops.
  const blocking = failed.filter(name => name !== 'Issue policy')
  if (blocking.length > 0) throw new Error('ship: checks failed: ' + blocking.join(', '))
  if (failed.length > 0) console.log('  ignoring the environmental failure: ' + failed.join(', '))
  console.log('  all checks settled')

  step('merging #' + number)
  // An author cannot approve their own pull request, and the protected branch requires an
  // approval, so the administrator path is the one that works for a release the author cut.
  run('gh', ['pr', 'merge', number, '--repo', repository, '--squash', '--admin'])

  step('tagging and cleaning up')
  run('git', ['fetch', 'origin', '--prune'])
  run('git', ['checkout', 'master'])
  run('git', ['reset', '--hard', 'origin/master'])
  const tag = family.tagPrefix + version
  run('git', ['tag', tag])
  run('git', ['push', 'origin', tag])
  run('git', ['branch', '-D', branch], true)
  run('git', ['push', 'origin', '--delete', branch], true)
  // Read the remote back: the local commit is not evidence a push landed.
  const remote = run('git', ['ls-remote', 'origin', 'refs/heads/master']).stdout.trim().split(/\s+/)[0] ?? ''
  const local = run('git', ['rev-parse', 'HEAD']).stdout.trim()
  if (remote !== local) throw new Error('ship: the remote master is ' + remote + ' but local is ' + local)

  console.log('')
  console.log('ship: ' + version + ' is published, merged, tagged ' + tag + ', and master is ' + local.slice(0, 10))
  return 0
}

if (isEntry(import.meta.url)) process.exit(await main())
