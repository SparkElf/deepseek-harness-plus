#!/usr/bin/env node
/**
 * Link each release package's profile-provided dependencies into its own node_modules.
 *
 * A release tree ships sources that resolve their third-party dependencies from the profile's
 * node_modules. A pnpm install inside the release rewrites the workspace graph and moves or
 * removes those links, and the scope check then reports the package as unresolvable -- which
 * fails every tool call with `reading 'prepare'` rather than stopping the service.
 *
 * This reads the scope checker's own report and restores exactly what it names, so the two
 * cannot disagree about what is missing.
 *
 * Usage: fix-nested-links.mjs --release <dir> [--check]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
let release
let check = false
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--release') { release = resolve(argv[i + 1]); i += 1; continue }
  if (argv[i] === '--check') { check = true; continue }
  throw new Error('unknown option: ' + argv[i])
}
if (release === undefined) throw new Error('usage: fix-nested-links.mjs --release <dir> [--check]')

const CHECKER = '/root/.dsh/supervisor/check-profile-scope.mjs'
const report = spawnSync(process.execPath, [CHECKER, '--release', release], { encoding: 'utf8' }).stdout ?? ''
if (report.includes('RESULT: healthy')) { console.log('fix-nested-links: healthy already'); process.exit(0) }

const profile = join(release, 'profile', 'node_modules')
let fixed = 0
for (const line of report.split('\n')) {
  const match = /^\s+(\S+)\s+(\S+)\s+node_modules=false\s+missing: (.+)$/.exec(line)
  if (match === null) continue
  const [, , directory, missing] = match
  const target = join(release, directory, 'node_modules')
  for (const name of missing.split(',').map(value => value.trim()).filter(Boolean)) {
    const source = join(profile, name)
    if (!existsSync(source)) { console.log('  skip ' + name + ' (not in the profile)'); continue }
    const link = join(target, name)
    // Resolve through the profile's own links before computing anything: a profile entry may
    // itself be a symlink to the pnpm store, and a relative path built from the link's spelling
    // rather than its target resolves to a directory that does not exist. A concurrent pnpm run
    // can clear the link while this walks the report, so an unresolvable entry is skipped rather
    // than aborting the whole repair.
    let resolved
    try {
      resolved = realpathSync(source)
    } catch (error) {
      console.log('  skip ' + name + ' (unresolvable: ' + (error && error.code ? error.code : 'unknown') + ')')
      continue
    }
    if (check) { console.log('  would link ' + link + ' -> ' + resolved); fixed += 1; continue }
    mkdirSync(target, { recursive: true })
    rmSync(link, { recursive: true, force: true })
    symlinkSync(resolved, link)
    console.log('  linked ' + name + ' into ' + directory)
    fixed += 1
  }
}
console.log('fix-nested-links: ' + (check ? 'would fix ' : 'fixed ') + String(fixed) + ' link(s)')
process.exit(0)
