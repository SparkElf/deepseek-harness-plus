#!/usr/bin/env node
/**
 * Archive a Session's superseded v3 log once its v4 log covers it.
 *
 * A Session that predates the v3→v4 format migration keeps both files in one directory:
 * `session.v3.jsonl.zstd` and `session.v4.jsonl.zstd`. The persistence layer resolves the
 * highest generation present, so it reads v4 and never runs the migration again — the v3
 * file stays behind as an orphan. The v4 decoder refuses the retired syntax that file
 * carries (`source.kind: "plugin"`, tool results without a tool-role message), and a read
 * that reaches those rows fails with "format v4 message requires a producer-owned source
 * kind" while the session is otherwise healthy.
 *
 * This moves the orphan aside. It moves rather than deletes, and it refuses to move a file
 * whose events the v4 log does not fully contain: the seq ranges must satisfy
 * `v4.min <= v3.min && v4.max >= v3.max`, so the archive can only ever hold data the live
 * log already reproduces.
 *
 * Usage:
 *   migrate-session-v3.mjs [--dry-run] [--sessions <dir>] [--archive <dir>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Default DSH home, matching the deployment this repository promotes. */
const DEFAULT_HOME = '/root/.dsh'

const argv = process.argv.slice(2)
let dryRun = false
let sessionsRoot = join(DEFAULT_HOME, 'sessions')
let archiveRoot = join(DEFAULT_HOME, 'sessions-archive-v3')
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--dry-run') { dryRun = true; continue }
  if (arg === '--sessions') { sessionsRoot = resolve(argv[++index]); continue }
  if (arg === '--archive') { archiveRoot = resolve(argv[++index]); continue }
  if (arg === '--help' || arg === '-h') {
    console.log('usage: migrate-session-v3.mjs [--dry-run] [--sessions <dir>] [--archive <dir>]')
    process.exit(0)
  }
  throw new Error('unknown option: ' + arg)
}

/**
 * Read one log's event sequence range.
 *
 * The header row carries no `seq`, so it is excluded rather than counted as zero.
 *
 * @param file - absolute path to a zstd-compressed JSONL Session log.
 * @returns the lowest and highest event seq, and how many events carried one.
 */
function sequenceRange(file) {
  const raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' })
  let min = Number.POSITIVE_INFINITY
  let max = -1
  let events = 0
  for (const line of raw.split('\n')) {
    if (line === '') continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (typeof row.seq !== 'number') continue
    events += 1
    if (row.seq < min) min = row.seq
    if (row.seq > max) max = row.seq
  }
  return { min, max, events }
}

function directories(path) {
  try { return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()) } catch { return [] }
}

const found = []
for (const project of directories(sessionsRoot)) {
  const projectPath = join(sessionsRoot, project.name)
  for (const session of directories(projectPath)) {
    const directory = join(projectPath, session.name)
    const v3 = join(directory, 'session.v3.jsonl.zstd')
    const v4 = join(directory, 'session.v4.jsonl.zstd')
    if (!existsSync(v3) || !existsSync(v4)) continue
    const source = sequenceRange(v3)
    const target = sequenceRange(v4)
    found.push({
      project: project.name,
      session: session.name,
      v3,
      archive: join(archiveRoot, project.name, session.name, 'session.v3.jsonl.zstd'),
      source,
      target,
      covered: target.min <= source.min && target.max >= source.max,
    })
  }
}

console.log('migrate-session-v3: ' + String(found.length) + ' session(s) hold both generations')
let moved = 0
let kept = 0
for (const entry of found) {
  const ok = entry.covered
  console.log('  ' + entry.session)
  console.log('    v3 seq ' + String(entry.source.min) + '→' + String(entry.source.max) + ' (' + String(entry.source.events) + ' events)')
  console.log('    v4 seq ' + String(entry.target.min) + '→' + String(entry.target.max) + ' (' + String(entry.target.events) + ' events)')
  console.log('    ' + (ok ? 'archivable: v4 covers every v3 event' : 'KEPT: v4 does not cover the v3 range'))
  if (!ok) { kept += 1; continue }
  if (dryRun) { moved += 1; continue }
  mkdirSync(join(entry.archive, '..'), { recursive: true })
  renameSync(entry.v3, entry.archive)
  moved += 1
}
console.log('')
console.log(dryRun ? 'migrate-session-v3: would archive ' + String(moved) : 'migrate-session-v3: archived ' + String(moved))
if (kept > 0) console.log('migrate-session-v3: kept ' + String(kept) + ' whose v4 log is incomplete')
if (!dryRun && moved > 0) console.log('migrate-session-v3: archive root ' + archiveRoot)
