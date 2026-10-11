#!/usr/bin/env node
/** Durable accepted-profile guard for the systemd Supervisor boundary. */

import { createHash } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const RUNTIME_FILE = /\.(?:cjs|diff|js|json|mjs|patch|wasm|ya?ml)$/u
const LF = String.fromCharCode(10)
const NUL = String.fromCharCode(0)

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const next = path + '.next'
  writeFileSync(next, JSON.stringify(value, null, 2) + LF, { mode: 0o600 })
  renameSync(next, path)
}

function runtimeFiles(directory) {
  const files = []
  for (const root of ['lib', 'patches', 'runtime']) {
    const absolute = join(directory, root)
    if (!existsSync(absolute)) continue
    const visit = (current, relative) => {
      for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const nextRelative = join(relative, entry.name)
        const next = join(current, entry.name)
        if (entry.isDirectory()) visit(next, nextRelative)
        else if (entry.isFile() && RUNTIME_FILE.test(entry.name) && !entry.name.endsWith('.map')) files.push(nextRelative)
      }
    }
    visit(absolute, root)
  }
  for (const name of ['package.json', 'cordis.patch.yml']) if (existsSync(join(directory, name))) files.push(name)
  return [...new Set(files)].sort()
}

function packageDirectories(profilePath) {
  const modules = join(profilePath, 'node_modules')
  const directories = []
  for (const entry of readdirSync(modules, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue
    const first = join(modules, entry.name)
    if (entry.name.startsWith('@')) {
      for (const child of readdirSync(first, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!child.name.startsWith('.')) directories.push(join(first, child.name))
      }
    } else {
      directories.push(first)
    }
  }
  return directories
}

function packageFingerprint(directory) {
  const hash = createHash('sha256')
  for (const relative of runtimeFiles(directory)) {
    hash.update(relative)
    hash.update(NUL)
    hash.update(readFileSync(join(directory, relative)))
    hash.update(NUL)
  }
  return hash.digest('hex')
}

/** Fingerprint one complete materialized profile runtime closure. */
export function fingerprintProfile(profilePath) {
  const absolute = realpathSync(profilePath)
  const packages = packageDirectories(absolute).map(directory => {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    return { name: manifest.name, fingerprint: packageFingerprint(directory) }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const hash = createHash('sha256')
  hash.update(readFileSync(join(absolute, 'package.json')))
  hash.update(NUL)
  for (const entry of packages) hash.update(entry.name + NUL + entry.fingerprint + NUL)
  return { profilePath: absolute, fingerprint: hash.digest('hex'), packageCount: packages.length }
}

function runtimeConfig(manifest) {
  const { state: _state, webPid: _webPid, phase: _phase, ...config } = manifest
  return config
}

/** Accept a closure-verified profile for subsequent Supervisor starts. */
export function acceptProfile({ profilePath, profileLink, manifestPath, statePath }) {
  const evidence = fingerprintProfile(profilePath)
  const manifest = runtimeConfig(JSON.parse(readFileSync(manifestPath, 'utf8')))
  const state = {
    formatVersion: 1,
    acceptedAt: new Date().toISOString(),
    profileLink: resolve(profileLink),
    manifestPath: resolve(manifestPath),
    acceptedProfile: evidence.profilePath,
    profileFingerprint: evidence.fingerprint,
    packageCount: evidence.packageCount,
    manifest,
  }
  atomicJson(statePath, state)
  return state
}

/** Restore the accepted profile before the Supervisor imports any profile code. */
export function guardAcceptedProfile({ statePath }) {
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  if (state.formatVersion !== 1) throw new Error('unsupported accepted-profile format')
  const evidence = fingerprintProfile(state.acceptedProfile)
  if (evidence.fingerprint !== state.profileFingerprint || evidence.packageCount !== state.packageCount) {
    throw new Error('accepted Plus profile runtime closure was modified')
  }
  let current
  try { current = realpathSync(state.profileLink) } catch { current = undefined }
  if (current === state.acceptedProfile) return { restored: false, acceptedProfile: state.acceptedProfile }
  if (existsSync(state.profileLink) && !lstatSync(state.profileLink).isSymbolicLink()) {
    throw new Error('refusing to replace non-symlink Plus profile path')
  }
  const next = state.profileLink + '.accepted-next'
  rmSync(next, { recursive: true, force: true })
  symlinkSync(state.acceptedProfile, next, 'dir')
  renameSync(next, state.profileLink)
  atomicJson(state.manifestPath, state.manifest)
  return { restored: true, previousProfile: current, acceptedProfile: state.acceptedProfile }
}

function parse(argv) {
  const values = { action: argv[0] ?? 'guard' }
  for (let index = 1; index < argv.length; index += 2) values[argv[index].replace(/^--/u, '')] = argv[index + 1]
  return values
}

function required(value, name) {
  if (typeof value !== 'string' || value === '') throw new Error('profile guard requires --' + name)
  return value
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parse(process.argv.slice(2))
  const statePath = required(args.state, 'state')
  try {
    const result = args.action === 'accept'
      ? acceptProfile({
          profilePath: required(args.profile, 'profile'),
          profileLink: required(args['profile-link'], 'profile-link'),
          manifestPath: required(args.manifest, 'manifest'),
          statePath,
        })
      : args.action === 'guard' ? guardAcceptedProfile({ statePath }) : (() => { throw new Error('unknown profile guard action') })()
    process.stdout.write(JSON.stringify(result) + LF)
  } catch (error) {
    // The systemd unit sends stderr to the runtime log, so an unhandled rejection leaves
    // the journal with only `status=1/FAILURE` while the reason accumulates in another
    // file. Naming the cause, the state file, and the fix on one stderr line puts it where
    // an operator looks first.
    process.stderr.write('profile-guard: ' + (error instanceof Error ? error.message : String(error))
      + LF + 'profile-guard: accepted state is ' + statePath
      + LF + 'profile-guard: after changing the profile, record it with '
      + "'profile-guard.mjs accept --profile <dir> --profile-link <link> --manifest <file> --state " + statePath + "'"
      + LF)
    process.exitCode = 1
  }
}
