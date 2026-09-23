/**
 * Publish one Plus release locally, then prove it is installable.
 *
 * The individual steps existed and were correct. What went wrong was the order a human
 * had to remember at the end of a rare procedure: pack, publish, and then wait for a
 * registry that answers 404 until it commits each packument, re-read every `latest` tag,
 * and install the result. Measured on this repository's own releases, that wait is minutes
 * and several attempts, and every step after `publish` was skipped whenever nobody
 * remembered it.
 *
 * This command runs the steps in the one order that works, so the same sequence serves a
 * release cut from CI and a version cut locally. CI keeps driving `release:pack` and
 * `release:publish` directly for a tagged release; both paths share that implementation.
 *
 * Usage: tsx scripts/release/local-publish.ts --family plus [--out <dir>] [--dry-run]
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { attemptEchoed, isEntry } from './process.ts'
import { releaseFamily } from './families.ts'

/**
 * One step of the sequence, run through pnpm so it sees the environment it expects.
 *
 * Every step goes through `pnpm run` because the scripts below resolve pnpm from
 * `npm_execpath`, which only a lifecycle script sets: spawned directly they fail with
 * "pnpm invocation: npm_execpath is unavailable".
 * @param label - step name, for the failure message.
 * @param script - package script to run.
 * @param args - extra arguments for it.
 */
function step(label: string, script: string, args: readonly string[] = []): void {
  console.log('')
  console.log('local-publish: ' + label)
  const result = attemptEchoed('pnpm', ['run', script, ...args])
  if (result.status !== 0) throw new Error(label + ' failed with exit code ' + String(result.status))
}

function main(): void {
  const { values } = parseArgs({
    options: {
      family: { type: 'string' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'skip-verify': { type: 'boolean', default: false },
    },
  })
  if (values.family === undefined) throw new Error('local-publish: --family is required')
  const family = releaseFamily(String(values.family))
  const directory = values.out === undefined
    ? mkdtempSync(join(tmpdir(), 'dsh-plus-local-publish-'))
    : resolve(String(values.out))
  const temporary = values.out === undefined
  const release = [family.id]

  try {
    // Packing states the release: the tarballs carry the members and versions that later
    // steps read, so nothing has to restate the list and drift from it.
    step('packing ' + family.id, 'release:pack', ['--family', family.id, '--out', directory])
    step('verifying the packed install', 'release:verify-packed-install', ['--family', family.id, '--from', directory])
    if (values['dry-run'] === true) {
      console.log('')
      console.log('local-publish: dry run, packed ' + directory + ' without publishing')
      return
    }
    step('publishing ' + family.id, 'release:publish', ['--family', family.id, '--from', directory])
    if (values['skip-verify'] !== true) {
      // Publication is not installability. This is the step a release loses when it is
      // treated as finished the moment publish exits.
      step('verifying the registry serves it', 'release:verify-published', ['--from', directory])
    }
  } finally {
    if (temporary) rmSync(directory, { recursive: true, force: true })
  }

  console.log('')
  console.log('local-publish: ' + release.join('') + ' is published and installable')
}

if (isEntry(import.meta.url)) main()
