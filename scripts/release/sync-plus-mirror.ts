/**
 * Synchronize a published Plus release to the mirror consumers install from.
 *
 * A publication writes to one registry. Users of this distribution install from the
 * mainland mirror, which serves a synchronized copy that appears only after it has
 * fetched the package. Publishing without this step leaves a release that works for
 * the publisher and answers 404 for everyone else — the packument of a brand-new
 * package first, then the tarball the install requests.
 *
 * Running this is not optional politeness: the mirror fetch is what makes the release
 * installable, and the verification here is what proves it did. The commands are
 * idempotent, so a re-run after a partial failure is safe.
 *
 * Usage:
 *   tsx scripts/release/sync-plus-mirror.ts --version 0.1.0-rc.33
 *   tsx scripts/release/sync-plus-mirror.ts --version 0.1.0-rc.33 --mirror https://registry.npmmirror.com
 */

import { fileURLToPath } from 'node:url'
import { attempt } from './process.ts'
import { releaseFamily } from './families.ts'

/** Repository root, so the family discovers the same members the publish used. */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Default mirror: the registry this distribution's users install from. */
const DEFAULT_MIRROR = 'https://registry.npmmirror.com'

/** How long one fetch may stay pending before the wait gives up. */
const POLL_INTERVAL_MILLISECONDS = 5_000

/** How long the mirror has to serve a package before the step fails. */
const READY_TIMEOUT_MILLISECONDS = 300_000

interface Options {
  readonly version: string
  readonly mirror: string
}

/**
 * Read the version and mirror from argv.
 *
 * The version comes from \`--version\` locally and from the release tag in CI, where the
 * workflow already checked that tag against every member's manifest; requiring it twice
 * would let the two disagree.
 * @param argv - arguments after the script name.
 * @returns the parsed options.
 */
function parseOptions(argv: readonly string[]): Options {
  let version: string | undefined
  let mirror = DEFAULT_MIRROR
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--version') {
      version = argv[index + 1]
      index += 1
      continue
    }
    if (token === '--mirror') {
      mirror = argv[index + 1] ?? mirror
      index += 1
      continue
    }
    throw new Error('unknown option: ' + token)
  }
  const ref = process.env.GITHUB_REF ?? ''
  const prefix = 'refs/tags/plus-npm-v'
  if (version === undefined && ref.startsWith(prefix)) version = ref.slice(prefix.length)
  if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('usage: sync-plus-mirror.ts --version <x.y.z[-pre]> [--mirror <url>]')
  }
  return { version, mirror }
}

/**
 * Name every Plus member that declares one release version.
 *
 * The family discovers members from the workspace, which is the same set the publish
 * packed; deriving names any other way could drift from what actually went out.
 * @param root - repository root.
 * @param version - the release version every member must declare.
 * @returns the member names, sorted.
 */
export function plusMemberNamesAt(root: string, version: string): string[] {
  const names = releaseFamily('plus').members(root)
    .filter(member => member.version === version)
    .map(member => member.name)
    .sort()
  if (names.length === 0) throw new Error('no Plus member declares version ' + version)
  return names
}

/** Whether one registry serves a version document. */
function versionServed(mirror: string, name: string, version: string): boolean {
  const encoded = name.replace('/', '%2F')
  const result = attempt('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', mirror + '/' + encoded + '/' + version])
  return result.stdout.trim() === '200'
}

/** Ask a mirror to fetch one package and report whether it accepted the request. */
function requestSync(mirror: string, name: string): boolean {
  const encoded = name.replace('/', '%2F')
  const result = attempt('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'PUT', mirror + '/-/package/' + encoded + '/syncs'])
  const status = result.stdout.trim()
  // 201 is a fresh request and 200 means one is already queued; both mean the mirror
  // knows the package, which is what this step needs.
  return status === '201' || status === '200'
}

/**
 * Synchronize every member of the Plus family and wait until the mirror serves it.
 * @param argv - arguments after the script name.
 * @returns the process exit code.
 */
async function main(argv: readonly string[]): Promise<number> {
  const { version, mirror } = parseOptions(argv)
  const names = plusMemberNamesAt(ROOT, version)
  console.log('sync-plus-mirror: ' + String(names.length) + ' package(s) at ' + version + ' -> ' + mirror)

  for (const name of names) {
    if (!requestSync(mirror, name)) throw new Error('the mirror refused a sync request for ' + name)
  }
  console.log('sync-plus-mirror: requested')

  const deadline = Date.now() + READY_TIMEOUT_MILLISECONDS
  const pending = new Set(names)
  while (pending.size > 0) {
    for (const name of [...pending]) {
      if (versionServed(mirror, name, version)) pending.delete(name)
    }
    if (pending.size === 0) break
    if (Date.now() >= deadline) {
      throw new Error('the mirror did not serve ' + String(pending.size) + ' package(s) in time: ' + [...pending].join(', '))
    }
    await new Promise((resolveWait) => { setTimeout(resolveWait, POLL_INTERVAL_MILLISECONDS) })
  }
  console.log('sync-plus-mirror: ' + String(names.length) + ' package(s) installable from ' + mirror)
  return 0
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
