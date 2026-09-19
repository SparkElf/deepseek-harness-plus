/**
 * Publish one packed release family from the tarballs the pack step produced.
 *
 * Publication is decided per package against the registry, never from a list of
 * "what this release includes": a version the registry lacks is published, a
 * version whose published tarball has the same integrity is skipped, and a
 * version whose published tarball differs fails the run — that last case means
 * the content changed without a version bump
 * ([rationale](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
 *
 * Skipping on identical integrity is what makes re-running the publish step over
 * the same artifact safe.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { releaseFamily } from './families.ts'
import type { ReleaseFamily } from './families.ts'
import { attempt, attemptEchoed, isEntry } from './process.ts'
import { packedIdentity, readPublishOrder } from './tarball.ts'

/**
 * Registry codes that answer a write which did not settle, rather than a
 * rejection of what was sent. `E409 Failed to save packument` is the one this
 * sequence actually hits: publishing several packages in a row can outrun the
 * registry's own processing. A rejected payload (`E403` over an existing
 * version, a malformed manifest) never clears on a retry and must surface.
 */
const TRANSIENT_PUBLISH_CODES = ['E409', 'E429', 'E500', 'E502', 'E503', 'E504', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'] as const

/** How many times one tarball's publish is attempted before the run fails. */
const PUBLISH_ATTEMPTS = 4

/**
 * Shortest gap between two publishes, and the first retry backoff.
 *
 * The registry needs a moment to commit a packument before the next write; back
 * to back publishes are what produce `E409`.
 */
const PUBLISH_SPACING_MS = 2_000

/** What the registry knows about one version. */
type RegistryState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly integrity: string }

/**
 * Whether a failed publish is worth another attempt.
 * @param output - combined npm output.
 * @returns True when the registry reported a write it did not commit.
 */
function isTransientFailure(output: string): boolean {
  return TRANSIENT_PUBLISH_CODES.some(code => output.includes(`code ${code}`))
}

/**
 * The subresource integrity string npm records for a tarball.
 * @param tarball - absolute tarball path.
 * @returns A `sha512-<base64>` string.
 */
function integrityOf(tarball: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
}

/**
 * Ask the registry whether a version exists, and with what integrity.
 * @param name - package name.
 * @param version - package version.
 * @returns The registry state for that version.
 */
function registryState(name: string, version: string): RegistryState {
  const result = attempt('npm', ['view', `${name}@${version}`, 'dist.integrity', '--json'])
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`
    if (output.includes('E404') || output.includes('404 Not Found')) return { kind: 'absent' }
    throw new Error(`npm view ${name}@${version} failed:\n${output}`)
  }
  const parsed: unknown = JSON.parse(result.stdout)
  // `npm view --json` answers a single field as an array whenever more than one
  // published version matches the spec, and as a bare string when exactly one does.
  // Both spellings carry the same one value; reading only the string spelling made
  // the publish step abort on every package whose name had older versions under a
  // different dist-tag, which is every package in a re-run.
  const integrity = Array.isArray(parsed) ? parsed[0] : parsed
  if (typeof integrity !== 'string' || integrity === '') {
    throw new Error(`registry reported no dist.integrity for ${name}@${version}`)
  }
  return { kind: 'present', integrity }
}

/**
 * Publish one tarball, retrying a registry write that did not settle.
 *
 * Every retry re-reads the registry first, because `E409` can answer a write
 * that landed anyway: republishing a version that now exists fails permanently,
 * so the same integrity appearing under the failed attempt counts as success.
 * @param tarball - absolute tarball path.
 * @param name - package name the tarball declares.
 * @param version - package version the tarball declares.
 * @param distTag - explicit npm dist-tag, or undefined for npm's `latest` default.
 */
async function publishTarball(
  tarball: string,
  name: string,
  version: string,
  distTag: string | undefined,
): Promise<void> {
  const tagArgs = distTag === undefined ? [] : ['--tag', distTag]
  for (let tries = 1; tries <= PUBLISH_ATTEMPTS; tries += 1) {
    // No --access: every release member declares its own publishConfig, and
    // a command-line flag would override it. check-workspace-constraints
    // requires a public access level on every release member.
    const result = attemptEchoed('npm', ['publish', tarball, ...tagArgs])
    const output = `${result.stdout}${result.stderr}`
    if (result.status === 0) return

    const settled = registryState(name, version)
    if (settled.kind === 'present' && settled.integrity === integrityOf(tarball)) {
      console.log(`release publish: ${name}@${version} landed despite a reported failure, continuing`)
      return
    }
    if (tries === PUBLISH_ATTEMPTS || !isTransientFailure(output)) {
      throw new Error(`npm publish ${name}@${version} failed:\n${output}`)
    }
    const backoff = PUBLISH_SPACING_MS * 2 ** (tries - 1)
    console.log(
      `release publish: ${name}@${version} hit a transient registry failure`
      + ` (attempt ${String(tries)} of ${String(PUBLISH_ATTEMPTS)}), retrying in ${String(backoff)}ms`,
    )
    await sleep(backoff)
  }
}

/**
 * Point `latest` at a version that was just published under a prerelease tag.
 *
 * Publishing a suffixed version puts it under `next`, so every release this
 * repository has made left `latest` where it was. A consumer who follows the
 * README's install line therefore receives whichever version was published before
 * the distribution took its present form: measured on @sparkelf/dsh-plus-standalone,
 * `latest` named 0.1.0-rc.35 while `next` named 0.2.0-rc.7, four days apart.
 *
 * Promotion is deliberately not part of publishing. `npm dist-tag add` is a second
 * write against a package that already exists, so it can fail on its own and it can
 * be judged on its own: the version stays published either way, and a failure here
 * reports which package needs the tag without pretending the publication failed.
 *
 * @param name - package whose tag moves.
 * @param version - version the tag should name.
 * @param distTag - the tag the version published under; `latest` is skipped for it.
 * @returns true when the tag was moved or already correct.
 */
function promoteLatest(name: string, version: string, distTag: string | undefined): boolean {
  if (distTag === 'latest') return false
  const current = attempt('npm', ['view', name, 'dist-tags.latest', '--json'])
  const parsed: unknown = current.status === 0 ? JSON.parse(current.stdout.trim() || '[]') : undefined
  const latest = Array.isArray(parsed) ? parsed[0] : parsed
  if (latest === version) return false
  const moved = attemptEchoed('npm', ['dist-tag', 'add', `${name}@${version}`, 'latest'])
  if (moved.status !== 0) {
    throw new Error(
      `published ${name}@${version} under '${String(distTag)}' but could not move latest`
      + ` from ${typeof latest === 'string' ? latest : 'an unknown version'}:`
      + `\n${moved.stdout}${moved.stderr}`,
    )
  }
  console.log(`release publish: ${name} latest -> ${version} (was ${typeof latest === 'string' ? latest : 'unknown'})`)
  return true
}

/**
 * Move `latest` for every member of a published set whose tag trails its version.
 *
 * This runs as its own pass after publication so a promotion failure cannot be
 * mistaken for a publication failure, and so an interrupted release can be finished
 * by running it again: each move is idempotent.
 *
 * @param directory - packed directory the release was published from.
 * @param family - family whose dist-tag policy decides what a prerelease means.
 * @returns the number of tags moved.
 */
function promoteFamilyLatest(directory: string, family: ReleaseFamily): number {
  let moved = 0
  for (const filename of readPublishOrder(directory)) {
    const tarball = join(directory, filename)
    const { name, version } = packedIdentity(tarball)
    if (promoteLatest(name, version, family.distTagForVersion(version))) moved += 1
  }
  return moved
}

/** Publish the family named by `--family` from the directory named by `--from`. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      family: { type: 'string' },
      from: { type: 'string' },
      'promote-latest': { type: 'boolean' },
    },
    allowPositionals: false,
  })
  if (values.family === undefined || values.from === undefined) {
    throw new Error(
      'usage: publish.ts --family <dsh|plus|vendor> --from <packed directory> [--promote-latest]',
    )
  }

  const family = releaseFamily(values.family)
  const directory = resolve(process.cwd(), values.from)

  // A promotion-only run finishes a release whose tags were left behind, without
  // republishing anything: every member is already present, so the publish pass
  // would skip all of them and then report the same summary.
  if (values['promote-latest'] === true) {
    const moved = promoteFamilyLatest(directory, family)
    console.log(`release publish: family ${family.id}, ${String(moved)} latest tag(s) moved`)
    return
  }

  // Every entry in the order settles as either published or already present, so
  // one counter answers "how far along is this run" for whoever is watching a
  // release that takes minutes per family.
  const order = readPublishOrder(directory)
  const total = String(order.length)
  let published = 0
  let skipped = 0
  for (const [index, filename] of order.entries()) {
    const progress = `[${String(index + 1)}/${total}]`
    const tarball = join(directory, filename)
    const { name, version } = packedIdentity(tarball)
    const state = registryState(name, version)
    if (state.kind === 'present') {
      const local = integrityOf(tarball)
      if (state.integrity !== local) {
        throw new Error(
          `${name}@${version} is already published with different content`
          + `\n  registry: ${state.integrity}\n  packed:   ${local}`
          + '\nBump the version, or investigate why the build is not reproducible.',
        )
      }
      console.log(`release publish: ${progress} ${name}@${version} already published, skipping`)
      skipped += 1
      continue
    }
    // Space out the writes: the gap belongs between publishes, so a run that
    // only skips does not wait at all.
    if (published > 0) await sleep(PUBLISH_SPACING_MS)
    await publishTarball(tarball, name, version, family.distTagForVersion(version))
    console.log(`release publish: ${progress} ${name}@${version} published`)
    published += 1
  }

  console.log(
    `release publish: family ${family.id}, ${total} member(s),`
    + ` ${String(published)} published, ${String(skipped)} already present`,
  )

  // Promotion follows publication rather than interleaving with it: the set is
  // complete and consistent at this point, so one failure leaves a published release
  // with stale tags - recoverable by re-running with --promote-latest - instead of a
  // half-published one.
  const moved = promoteFamilyLatest(directory, family)
  console.log(`release publish: ${String(moved)} latest tag(s) moved`)
}

if (isEntry(import.meta.url)) await main()
