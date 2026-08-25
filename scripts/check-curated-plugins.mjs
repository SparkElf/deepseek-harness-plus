#!/usr/bin/env node
/**
 * Curated external plugin drift checker. Compares each curated.yaml pin
 * against the latest published version (npm) or remote head (git) and prints
 * a drift report; exits non-zero with --fail-on-drift. The manifest stays in
 * a simple YAML subset parsed here without dependencies; --offline skips
 * network access, while an incomplete lookup fails an online check.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const GITHUB_PULL_REQUEST_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/u

function parseScalar(text) {
  const value = text.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/u.test(value)) return Number(value)
  return value.replace(/^['"]|['"]$/gu, '')
}

function parseFlowMap(text) {
  const inner = text.trim().replace(/^\{|\}$/gu, '')
  const map = {}
  for (const part of inner.split(',')) {
    const idx = part.indexOf(':')
    if (idx === -1) continue
    map[part.slice(0, idx).trim()] = parseScalar(part.slice(idx + 1))
  }
  return map
}

function parseFlowList(text) {
  const inner = text.trim().replace(/^\[|\]$/gu, '').trim()
  if (inner === '') return []
  const items = []
  let start = 0
  let depth = 0
  for (let index = 0; index < inner.length; index += 1) {
    if (inner[index] === '{') depth += 1
    else if (inner[index] === '}') depth -= 1
    else if (inner[index] === ',' && depth === 0) {
      items.push(inner.slice(start, index).trim())
      start = index + 1
    }
  }
  items.push(inner.slice(start).trim())
  return items.map((item) => {
    if (!item.startsWith('{') || !item.endsWith('}')) throw new Error('curated.yaml: flow list entries must be maps')
    return parseFlowMap(item)
  })
}

/**
 * Parse the curated manifest (simple YAML subset: one `entries:` list of flat
 * maps with optional inline flow maps and empty lists).
 * @param text - YAML text of the manifest.
 * @returns the entry list (empty when absent).
 */
export function parseManifest(text) {
  const entries = []
  let current
  let inEntries = false
  for (const raw of text.split(/\r?\n/u)) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue
    if (!raw.startsWith(' ')) {
      if (raw.trim() === 'entries:') { inEntries = true; continue }
      if (raw.trim() === 'entries: []') { inEntries = false; continue }
      if (raw.trim().startsWith('entries:')) throw new Error('curated.yaml: entries must be a list')
      inEntries = false
      continue
    }
    if (!inEntries) continue
    const line = raw.trim()
    if (line.startsWith('- ')) {
      current = {}
      entries.push(current)
      const rest = line.slice(2).trim()
      if (rest !== '') {
        const idx = rest.indexOf(':')
        current[rest.slice(0, idx).trim()] = parseScalar(rest.slice(idx + 1))
      }
      continue
    }
    if (current === undefined) throw new Error('curated.yaml: entry field outside an entry')
    const idx = line.indexOf(':')
    if (idx === -1) throw new Error('curated.yaml: malformed line: ' + line)
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (value.startsWith('{')) current[key] = parseFlowMap(value)
    else if (value.startsWith('[')) current[key] = parseFlowList(value)
    else if (value === '') current[key] = undefined
    else current[key] = parseScalar(value)
  }
  for (const entry of entries) {
    if (!entry?.name || !entry?.source?.kind || entry?.pinned === undefined) {
      throw new Error('curated.yaml: every entry needs name, source.kind, and pinned')
    }
    if (entry.source.kind === 'npm' && !entry.source.spec) throw new Error('curated.yaml: npm sources need spec')
    if (entry.source.kind === 'git' && !entry.source.url) throw new Error('curated.yaml: git sources need url')
    if (entry.source.kind !== 'npm' && entry.source.kind !== 'git') throw new Error('curated.yaml: source.kind must be npm or git')
    if (!Array.isArray(entry.localPatches)) throw new Error('curated.yaml: localPatches must be a list')
    for (const patch of entry.localPatches) {
      if (!patch.file || !patch.upstreamUrl || !patch.retireWhen) {
        throw new Error('curated.yaml: every local patch needs file, upstreamUrl, and retireWhen')
      }
      if (!GITHUB_PULL_REQUEST_URL.test(patch.upstreamUrl)) {
        throw new Error('curated.yaml: local patch upstreamUrl must be a GitHub pull request URL')
      }
    }
  }
  return entries
}

/**
 * Compare one pin against a latest value.
 * @param entry - manifest entry.
 * @param latest - latest published version or remote head.
 * @returns drift record.
 */
export function comparePin(entry, latest) {
  return { name: entry.name, pinned: entry.pinned, latest, drifted: String(entry.pinned) !== String(latest) }
}

/**
 * Check that every default-mounted npm plugin is present at the curated pin.
 * @param entries - parsed curated plugin entries.
 * @param dependencies - Web Bundle dependency versions.
 * @param defaultBundles - shipped Web profile Bundle names.
 * @returns actionable mismatch diagnostics.
 */
export function bundledPinIssues(entries, dependencies, defaultBundles) {
  const issues = []
  for (const entry of entries) {
    if (entry.plusBundle !== true) continue
    if (entry.source.kind !== 'npm' || typeof entry.source.spec !== 'string') {
      issues.push(`${entry.name}: plusBundle entries must use an npm source spec`)
      continue
    }
    const actual = dependencies[entry.source.spec]
    if (actual !== String(entry.pinned)) {
      issues.push(`${entry.name}: curated pin ${entry.pinned} must equal packages/bundle/web-app dependency ${String(actual)}`)
    }
    if (!defaultBundles.includes(entry.source.spec)) {
      issues.push(`${entry.name}: npm source ${entry.source.spec} is missing from PROFILE_TEMPLATES.web`)
    }
  }
  return issues
}

/**
 * Check that curated npm patches are registered under the matching pin.
 * @param entries - parsed curated plugin entries.
 * @param patchedDependencies - pnpm patched dependency registrations.
 * @returns actionable patch registration diagnostics.
 */
export function localPatchIssues(entries, patchedDependencies) {
  const issues = []
  for (const entry of entries) {
    if (entry.localPatches.length === 0) continue
    if (entry.source.kind !== 'npm' || typeof entry.source.spec !== 'string') {
      issues.push(`${entry.name}: local patches require an npm source spec`)
      continue
    }
    const key = `${entry.source.spec}@${entry.pinned}`
    for (const patch of entry.localPatches) {
      if (patchedDependencies[key] !== patch.file) {
        issues.push(`${entry.name}: ${key} must register ${patch.file} in pnpm-workspace.yaml`)
      }
    }
  }
  return issues
}

/**
 * Return the process status for a completed upstream check.
 * @param drifted - number of pins that differ from upstream.
 * @param lookupFailed - number of incomplete upstream lookups.
 * @param failOnDrift - whether drift makes the command fail.
 * @returns 1 for incomplete data, 2 for requested drift failure, otherwise 0.
 */
export function driftExitCode(drifted, lookupFailed, failOnDrift) {
  if (lookupFailed > 0) return 1
  if (failOnDrift && drifted > 0) return 2
  return 0
}

function npmLatest(spec) {
  return execFileSync('npm', ['view', spec, 'version'], { encoding: 'utf8' }).trim()
}

function gitHead(url) {
  return execFileSync('git', ['ls-remote', url, 'HEAD'], { encoding: 'utf8' }).split(/\s+/)[0]
}

/**
 * Run the curated plugin drift check.
 * @param args - CLI arguments after the executable and script path.
 * @returns the process status without terminating an importing process.
 */
export function main(args = process.argv.slice(2)) {
  const offline = args.includes('--offline')
  const failOnDrift = args.includes('--fail-on-drift')
  const manifestPath = args.find(value => !value.startsWith('--'))
    ?? resolve(dirname(fileURLToPath(import.meta.url)), '../.agents/plugins/curated.yaml')

  const entries = parseManifest(readFileSync(manifestPath, 'utf8'))
  let drifted = 0
  let lookupFailed = 0
  for (const entry of entries) {
    if (offline) {
      console.log(`${entry.name}: pinned ${entry.pinned} (offline, latest not checked)`)
      continue
    }
    try {
      const latest = entry.source.kind === 'npm' ? npmLatest(entry.source.spec) : gitHead(entry.source.url)
      const record = comparePin(entry, latest)
      if (record.drifted) drifted += 1
      console.log(`${record.name}: pinned ${record.pinned}, latest ${record.latest}${record.drifted ? '  DRIFT' : ''}`)
    } catch (error) {
      lookupFailed += 1
      console.log(`${entry.name}: lookup failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return driftExitCode(drifted, lookupFailed, failOnDrift)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
