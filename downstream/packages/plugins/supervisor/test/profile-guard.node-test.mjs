import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { acceptProfile, guardAcceptedProfile } from '../runtime/profile-guard.mjs'

const LF = String.fromCharCode(10)

function profile(root, name, source) {
  const directory = join(root, name)
  const packageDirectory = join(directory, 'node_modules/@fixture/client')
  mkdirSync(join(packageDirectory, 'lib'), { recursive: true })
  mkdirSync(join(packageDirectory, 'patches'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: 'fixture-profile',
    dsh: { profile: { bundles: ['@fixture/client'] } },
  }) + LF)
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ name: '@fixture/client', version: '1.0.0' }) + LF)
  writeFileSync(join(packageDirectory, 'lib/client.js'), source + LF)
  writeFileSync(join(packageDirectory, 'patches/ui.patch'), 'patch payload' + LF)
  return directory
}

function replaceLink(link, target) {
  const next = link + '.next'
  rmSync(next, { recursive: true, force: true })
  symlinkSync(target, next, 'dir')
  renameSync(next, link)
}

test('restores the accepted profile and runtime manifest before startup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-guard-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const accepted = profile(root, 'accepted', 'export const ui = "current"')
  const stale = profile(root, 'stale', 'export const ui = "old"')
  const profileLink = join(root, 'profiles/plus')
  const manifestPath = join(root, 'supervisor/runtime.json')
  const statePath = join(root, 'supervisor/accepted-profile.json')
  mkdirSync(join(root, 'profiles'), { recursive: true })
  mkdirSync(join(root, 'supervisor'), { recursive: true })
  symlinkSync(accepted, profileLink, 'dir')
  writeFileSync(manifestPath, JSON.stringify({
    dshHome: root,
    port: 3080,
    runtime: { command: 'node', args: ['accepted.js'], cwd: accepted },
    state: 'running',
    webPid: 123,
  }) + LF)

  const state = acceptProfile({ profilePath: accepted, profileLink, manifestPath, statePath })
  assert.equal(state.packageCount, 1)
  assert.equal('state' in state.manifest, false)
  replaceLink(profileLink, stale)
  writeFileSync(manifestPath, JSON.stringify({ runtime: { command: 'node', args: ['stale.js'], cwd: stale } }) + LF)

  const result = guardAcceptedProfile({ statePath })
  assert.equal(result.restored, true)
  assert.equal(realpathSync(profileLink), realpathSync(accepted))
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).runtime.args, ['accepted.js'])
})

test('refuses rollback when the accepted closure was modified', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-guard-tamper-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const accepted = profile(root, 'accepted', 'export const ui = "current"')
  const profileLink = join(root, 'profiles/plus')
  const manifestPath = join(root, 'supervisor/runtime.json')
  const statePath = join(root, 'supervisor/accepted-profile.json')
  mkdirSync(join(root, 'profiles'), { recursive: true })
  mkdirSync(join(root, 'supervisor'), { recursive: true })
  symlinkSync(accepted, profileLink, 'dir')
  writeFileSync(manifestPath, JSON.stringify({ runtime: { command: 'node', args: [], cwd: accepted } }) + LF)
  acceptProfile({ profilePath: accepted, profileLink, manifestPath, statePath })
  writeFileSync(join(accepted, 'node_modules/@fixture/client/patches/ui.patch'), 'tampered' + LF)
  assert.throws(() => guardAcceptedProfile({ statePath }), /runtime closure was modified/u)
})

test('names the cause and the fix on stderr when the guard rejects a modified profile', async t => {
  // The unit sends stderr to the runtime log, so a bare exit code leaves the journal
  // with nothing to act on. The message must carry the cause and the recovery command.
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-guard-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const accepted = profile(root, 'accepted', 'export const ui = "current"')
  const profileLink = join(root, 'profiles/plus')
  const manifestPath = join(root, 'supervisor/runtime.json')
  const statePath = join(root, 'supervisor/accepted-profile.json')
  mkdirSync(join(root, 'profiles'), { recursive: true })
  mkdirSync(join(root, 'supervisor'), { recursive: true })
  symlinkSync(accepted, profileLink, 'dir')
  writeFileSync(manifestPath, JSON.stringify({ runtime: { command: 'node', args: [], cwd: accepted } }) + LF)
  acceptProfile({ profilePath: accepted, profileLink, manifestPath, statePath })
  writeFileSync(join(accepted, 'node_modules/@fixture/client/patches/ui.patch'), 'tampered' + LF)

  const guard = fileURLToPath(new URL('../runtime/profile-guard.mjs', import.meta.url))
  const ran = spawnSync(process.execPath, [guard, 'guard', '--state', statePath], { encoding: 'utf8' })
  assert.equal(ran.status, 1)
  assert.match(ran.stderr, /runtime closure was modified/u)
  assert.match(ran.stderr, /accept --profile/u)
  assert.ok(ran.stderr.includes(statePath))
})
