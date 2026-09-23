/**
 * Prove a published release is installable, in one command.
 *
 * Publication reports success before the registry serves the package. The write returns
 * 200, and `npm view` answers 404 for a packument the registry has not committed yet —
 * measured on this repository's own releases, where re-reading took several minutes and
 * four attempts. Publish therefore cannot be the last step of a release: the versions a
 * consumer resolves are a fact about the registry, not about the publish command.
 *
 * What this needs from a release is the member list and version that went out, which it
 * reads from the packed tarballs rather than from a second list that could drift.
 *
 * Usage: tsx scripts/release/verify-published.ts --from <packed-dir> [--registry <url>]
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { isEntry } from './process.ts'
import { packedIdentity } from './tarball.ts'

/** How long one version may take to appear, and how often to ask. */
const SERVE_TIMEOUT_MILLISECONDS = 15 * 60_000
const SERVE_POLL_MILLISECONDS = 15_000

/** Run one command and capture it, never throwing. */
function attempt(command: string, args: readonly string[]): { status: number | null; stdout: string } {
  const result = spawnSync(command, [...args], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '' }
}

/** One published member, read from its packed manifest. */
interface PublishedMember {
  readonly name: string
  readonly version: string
}

/**
 * Read the members a packed release carries.
 *
 * The packing step wrote these manifests, so the list is the release rather than a
 * restatement of it: a member that was packed but not published is exactly what this
 * command exists to find.
 * @param directory - output directory of the pack step.
 * @returns each member's name and version, sorted by name.
 */
function readPackedMembers(directory: string): PublishedMember[] {
  const members: PublishedMember[] = []
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith('.tgz')) continue
    const identity = packedIdentity(join(directory, entry))
    members.push({ name: identity.name, version: identity.version })
  }
  return members.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Ask the registry which versions it serves for one package.
 *
 * `npm view` treats an uncommitted packument as an error rather than an empty answer, so
 * the exit status carries the same information as the output: a non-zero status means the
 * registry does not serve the package yet.
 * @param registry - registry to query.
 * @param name - package name.
 * @returns the versions the registry reports, or an empty list while it serves none.
 */
function servedVersions(registry: string, name: string): string[] {
  const result = attempt('npm', ['view', name, 'versions', '--json', '--registry', registry])
  if (result.status !== 0) return []
  try {
    const parsed: unknown = JSON.parse(result.stdout)
    if (Array.isArray(parsed)) return parsed.map(String)
    // A single published version is serialised as a bare string rather than an array.
    return typeof parsed === 'string' ? [parsed] : []
  } catch {
    // Unparseable output means the registry answered something other than a version list,
    // which is not evidence that the version is served.
    return []
  }
}

/**
 * Read the dist-tag the release should have moved.
 *
 * Every Plus version carries a prerelease suffix, so the publish step tags it `next` and
 * then moves `latest` onto it; a consumer running the documented install command resolves
 * `latest`, which is the tag this checks.
 * @param registry - registry to query.
 * @param name - package name.
 * @returns the version `latest` names, or undefined when the tag is unreadable.
 */
function latestTag(registry: string, name: string): string | undefined {
  const result = attempt('npm', ['view', name, 'dist-tags.latest', '--registry', registry])
  const value = result.stdout.trim()
  return result.status === 0 && value !== '' ? value : undefined
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      registry: { type: 'string', default: 'https://registry.npmjs.org' },
      timeout: { type: 'string' },
    },
  })
  if (values.from === undefined) throw new Error('verify-published: --from <packed-dir> is required')
  const directory = resolve(values.from)
  const registry = String(values.registry)
  const timeout = values.timeout === undefined ? SERVE_TIMEOUT_MILLISECONDS : Number(values.timeout)
  const members = readPackedMembers(directory)
  if (members.length === 0) throw new Error('verify-published: ' + directory + ' holds no tarball')
  console.log('verify-published: ' + String(members.length) + ' member(s) in ' + directory)

  // A release is servable only as a whole: one member the registry lacks is an
  // installation that fails for every consumer, so the wait covers all of them.
  const pending = new Map(members.map(member => [member.name, member.version]))
  const deadline = Date.now() + timeout
  for (;;) {
    for (const [name, version] of [...pending]) {
      if (servedVersions(registry, name).includes(version)) {
        console.log('  served  ' + name + '@' + version)
        pending.delete(name)
      }
    }
    if (pending.size === 0) break
    if (Date.now() >= deadline) {
      console.error('verify-published: the registry still does not serve:')
      for (const [name, version] of pending) console.error('  - ' + name + '@' + version)
      return 1
    }
    console.log('  waiting for ' + String(pending.size) + ' member(s)')
    await sleep(SERVE_POLL_MILLISECONDS)
  }

  // A version the registry serves is not yet a version a consumer installs: the
  // documented command resolves `latest`, which publication moves as a separate write.
  let staleTags = 0
  for (const member of members) {
    const tag = latestTag(registry, member.name)
    if (tag === member.version) continue
    console.error('  latest  ' + member.name + ' names ' + String(tag) + ', not ' + member.version)
    staleTags += 1
  }
  if (staleTags > 0) {
    console.error('verify-published: ' + String(staleTags) + ' member(s) are not what latest resolves')
    return 1
  }

  console.log('verify-published: every member is served and latest resolves it')
  return 0
}

if (isEntry(import.meta.url)) process.exit(await main())
