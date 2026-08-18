#!/usr/bin/env node
/**
 * Curated external plugin drift checker. Compares each curated.yaml pin
 * against the latest published version (npm) or remote head (git) and prints
 * a drift report; exits non-zero with --fail-on-drift. The manifest stays in
 * a simple YAML subset parsed here without dependencies; network lookups are
 * skipped with --offline.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    else if (value === '[]') current[key] = []
    else if (value === '') current[key] = undefined
    else current[key] = parseScalar(value)
  }
  for (const entry of entries) {
    if (!entry?.name || !entry?.source?.kind || entry?.pinned === undefined) {
      throw new Error('curated.yaml: every entry needs name, source.kind, and pinned')
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

function npmLatest(spec) {
  return execFileSync('npm', ['view', spec, 'version'], { encoding: 'utf8' }).trim()
}

function gitHead(url) {
  return execFileSync('git', ['ls-remote', url, 'HEAD'], { encoding: 'utf8' }).split(/\s+/)[0]
}

const args = process.argv.slice(2)
const offline = args.includes('--offline')
const failOnDrift = args.includes('--fail-on-drift')
const manifestPath = args.find(value => !value.startsWith('--'))
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '../.agents/plugins/curated.yaml')

const entries = parseManifest(readFileSync(manifestPath, 'utf8'))
let drifted = 0
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
    console.log(`${entry.name}: lookup failed (${error instanceof Error ? error.message : String(error)})`)
  }
}
if (failOnDrift && drifted > 0) process.exit(2)
