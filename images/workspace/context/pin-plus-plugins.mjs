#!/usr/bin/env node
/**
 * Pin registry plugins past the reviewed plus edition, or verify an installed profile.
 *
 * The plus distribution (`sparkelf-dsh-plus-<version>.tgz`) is the reviewed release and its
 * `intranet-team` edition pins every plugin exactly once. When a DataOps plugin fix ships as a
 * new package version, the edition is not republished just for this deployment: the pins are
 * checked in at `profile-defaults/plugin-pins.json`, rewritten into the tarball's own metadata
 * before anything installs it, and asserted again on the installed profile. That keeps the
 * tarball, the profile projection and the running tree on one reviewed version instead of
 * relying on a container commit.
 *
 * Usage:
 *   node pin-plus-plugins.mjs --tarball /tmp/sparkelf-dsh-plus.tgz --pins profile-defaults/plugin-pins.json
 *   node pin-plus-plugins.mjs --verify-profile /opt/dataops-dsh-profile-template --pins <file>
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

/** Where the plus install can resolve a vendored tarball dependency inside the image. */
const VENDORED_PLUGIN_ROOT = '/opt/dataops-vendor'

/**
 * Read one option value.
 *
 * @param argv - arguments after the script name.
 * @param name - option to look for.
 * @returns the value that follows it, if present.
 */
function option(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

/**
 * Split one pin row into the package it resolves to, the exact version required, and how the
 * build obtains those bytes. A string is a registry specifier; the object form installs a
 * vendored tarball whose sha256 is checked both by the Dockerfile before the install and here.
 */
function resolveSpec(rowName, spec) {
  if (spec !== null && typeof spec === 'object') {
    if (spec.source !== 'tarball') {
      throw new Error(`${rowName}: object pin source must be "tarball"`)
    }
    if (typeof spec.package !== 'string' || !spec.package.includes('/')) {
      throw new Error(`${rowName}: tarball pin needs a scoped "package" name`)
    }
    if (typeof spec.version !== 'string' || !/^[0-9]/.test(spec.version)) {
      throw new Error(`${rowName}: tarball pin needs an exact "version"`)
    }
    if (typeof spec.file !== 'string' || !spec.file.endsWith('.tgz')) {
      throw new Error(`${rowName}: tarball pin needs a .tgz "file"`)
    }
    if (typeof spec.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(spec.sha256)) {
      throw new Error(`${rowName}: tarball pin needs a lowercase sha256`)
    }
    return {
      packageName: spec.package,
      version: spec.version,
      source: 'tarball',
      file: spec.file,
      sha256: spec.sha256,
    }
  }
  if (spec.startsWith('npm:')) {
    const target = spec.slice('npm:'.length)
    const at = target.lastIndexOf('@')
    if (at <= 0) throw new Error(`${rowName}: malformed npm alias '${spec}'`)
    return { packageName: target.slice(0, at), version: target.slice(at + 1) }
  }
  if (/^[0-9]/.test(spec)) return { packageName: rowName, version: spec }
  throw new Error(`${rowName}: pin '${spec}' is not an exact version, an npm: alias, or a tarball pin`)
}

/** Resolve a tarball pin to the path the profile install reads, after checking its bytes. */
function vendoredSpec(rowName, resolved) {
  const vendored = join(VENDORED_PLUGIN_ROOT, basename(resolved.file))
  const digest = createHash('sha256').update(readFileSync(vendored)).digest('hex')
  if (digest !== resolved.sha256) {
    throw new Error(`${rowName}: vendored tarball sha256 ${digest} does not match the pin`)
  }
  return 'file:' + vendored
}

const argv = process.argv.slice(2)
const pinsPath = option(argv, '--pins')
const tarball = option(argv, '--tarball')
const profile = option(argv, '--verify-profile')
if (pinsPath === undefined || (tarball === undefined) === (profile === undefined)) {
  throw new Error('usage: pin-plus-plugins.mjs (--tarball <tgz> | --verify-profile <dir>) --pins <json>')
}

const pins = JSON.parse(readFileSync(pinsPath, 'utf8')).pins ?? {}
const rows = Object.entries(pins)
if (rows.length === 0) throw new Error(`${pinsPath}: no pins`)
const resolvedRows = rows.map(([rowName, spec]) => [rowName, resolveSpec(rowName, spec)])

if (tarball !== undefined) {
  const directory = mkdtempSync(join(tmpdir(), 'dataops-plus-pins-'))
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', directory])
    const manifestPath = join(directory, 'package', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const dependencies = manifest.dshPlus?.profile?.dependencies
    if (dependencies === undefined || typeof dependencies !== 'object') {
      throw new Error(`${tarball}: dshPlus.profile.dependencies is missing`)
    }
    for (const [rowName, resolved] of resolvedRows) {
      const value = resolved.source === 'tarball' ? vendoredSpec(rowName, resolved) : pins[rowName]
      dependencies[rowName] = value
      console.log(`  pin ${rowName} -> ${value}`)
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    execFileSync('tar', ['-czf', tarball, '-C', directory, 'package'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  const packed = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
  for (const [rowName, resolved] of resolvedRows) {
    const expected = resolved.source === 'tarball' ? vendoredSpec(rowName, resolved) : pins[rowName]
    if (packed.dshPlus?.profile?.dependencies?.[rowName] !== expected) {
      throw new Error(`${tarball}: pin ${rowName} did not survive the repack`)
    }
  }
  console.log(`  plus tarball carries ${rows.length} DataOps pins`)
} else {
  const failures = []
  for (const [rowName, { packageName, version }] of resolvedRows) {
    const manifestPath = join(profile, 'node_modules', rowName, 'package.json')
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      failures.push(`${rowName}: no installed package at ${manifestPath}`)
      continue
    }
    if (manifest.name !== packageName) failures.push(`${rowName}: installed package is ${manifest.name}, expected ${packageName}`)
    if (manifest.version !== version) failures.push(`${rowName}: installed ${manifest.version}, expected ${version}`)
  }
  if (failures.length > 0) throw new Error(`plugin pins not satisfied in ${profile}:\n  ` + failures.join('\n  '))
  console.log(`  profile carries ${rows.length} DataOps pins at the reviewed versions`)
}