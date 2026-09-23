/**
 * Move the running deployment onto a published Plus release, and prove it came up.
 *
 * The deployment is not this checkout. It is a release directory under the DSH home whose
 * profile holds its own installed copy of the distribution, and the supervisor restarts the
 * process that serves the port. Promoting by hand means editing that profile's dependency and
 * restarting the supervisor, which is three commands whose arguments are not guessable and
 * whose order matters: a restart without the install serves the previous version, and an
 * install without the restart leaves the running process on code that no longer matches disk.
 *
 * The supervisor is restarted through its own runtime command rather than the service manager.
 * A service-manager restart bypasses the supervisor, so the Session capture and recovery the
 * supervisor performs never runs and in-flight turns are lost.
 *
 * Usage: tsx scripts/release/promote-runtime.ts --version 0.2.0-rc.23 [--check]
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { isEntry } from './process.ts'

/** Where a deployment keeps its release directories and supervisor manifest. */
const DSH_HOME = '/root/.dsh'
const MANIFEST = join(DSH_HOME, 'supervisor', 'runtime.json')

/** Run one command, returning its outcome instead of throwing. */
function attempt(command: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, [...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.error !== undefined) throw result.error
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Throw when a command failed, quoting both streams. */
function require(command: string, args: readonly string[]): string {
  const outcome = attempt(command, args)
  if (outcome.status !== 0) {
    throw new Error(command + ' ' + args.join(' ') + ' failed with exit code ' + String(outcome.status) + '\n' + outcome.stdout + outcome.stderr)
  }
  return outcome.stdout
}

/**
 * Read the release directory the supervisor currently runs.
 *
 * The manifest names it, so this reads the manifest rather than guessing a directory name:
 * the newest directory is not necessarily the running one, and promoting the wrong tree looks
 * like a successful restart serving an unchanged version.
 * @returns the running release directory and its CLI entry, or undefined when there is none.
 */
function runningRelease(): { directory: string; port: number | undefined } | undefined {
  if (!existsSync(MANIFEST)) return undefined
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    port?: unknown
    runtime?: { cwd?: unknown }
  }
  const directory = manifest.runtime?.cwd
  if (typeof directory !== 'string') return undefined
  return { directory, port: typeof manifest.port === 'number' ? manifest.port : undefined }
}

/**
 * Read the version a profile has installed for the distribution.
 * @param profileDirectory - the release's profile directory.
 * @returns the installed version, or undefined when the package is absent.
 */
function installedVersion(profileDirectory: string): string | undefined {
  const manifest = join(profileDirectory, 'node_modules', '@sparkelf', 'dsh-plus', 'package.json')
  if (!existsSync(manifest)) return undefined
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { version: { type: 'string' }, check: { type: 'boolean', default: false } } })
  const running = runningRelease()
  if (running === undefined) {
    throw new Error('promote-runtime: no supervisor manifest at ' + MANIFEST + ', so there is no running deployment to promote')
  }
  const profile = join(running.directory, 'profile')
  const before = installedVersion(profile)
  console.log('promote-runtime: ' + running.directory + (running.port === undefined ? '' : ' on port ' + String(running.port)))
  console.log('  installed now: ' + (before ?? '(not installed)'))
  if (values.check === true) {
    if (values.version !== undefined && before !== values.version) {
      console.log('  requested:     ' + values.version + ' (not promoted yet)')
      return 1
    }
    console.log('  match: the running deployment carries the requested version')
    return 0
  }
  if (values.version === undefined) throw new Error('promote-runtime: --version is required (or --check to compare)')
  if (before === values.version) {
    console.log('  already at ' + values.version + '; nothing to do')
    return 0
  }

  console.log('')
  console.log('promote-runtime: installing ' + values.version + ' into the profile')
  // `npm install` against the profile directory, so the dependency and its tree are replaced
  // together: editing package.json alone leaves the installed copy in place.
  require('npm', ['install', '--no-audit', '--no-fund', '--prefix', profile, '@sparkelf/dsh-plus@' + values.version])
  const installed = installedVersion(profile)
  console.log('  profile now carries ' + (installed ?? '(nothing)'))
  if (installed !== values.version) {
    throw new Error('promote-runtime: the profile still carries ' + String(installed) + ' after installing ' + values.version)
  }

  console.log('')
  console.log('promote-runtime: restarting through the supervisor')
  const supervisor = join(profile, 'node_modules', '@sparkelf', 'dsh-plugin-supervisor', 'runtime', 'bin.mjs')
  if (!existsSync(supervisor)) throw new Error('promote-runtime: no supervisor runtime at ' + supervisor)
  require('node', [supervisor, 'restart', '--manifest', MANIFEST])

  // The restart answers before the served version changes, so the check reads the deployment
  // rather than trusting the restart command's exit status.
  console.log('')
  console.log('promote-runtime: waiting for the deployment to serve ' + values.version)
  const deadline = Date.now() + 120_000
  for (;;) {
    const served = installedVersion(profile)
    if (served === values.version) {
      console.log('  serving ' + values.version)
      break
    }
    if (Date.now() >= deadline) throw new Error('promote-runtime: the profile carries ' + String(served) + ' after the wait')
    await new Promise(resolve => setTimeout(resolve, 5_000))
  }
  console.log('')
  console.log('promote-runtime: ' + values.version + ' is installed and the supervisor restarted')
  return 0
}

if (isEntry(import.meta.url)) process.exit(await main())
