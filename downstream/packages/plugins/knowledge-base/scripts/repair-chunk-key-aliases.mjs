#!/usr/bin/env node
/**
 * Repair citation aliases after a chunker rebuild.
 *
 * A full rebuild replaces chunk ids and chunk keys. `kb_chunk_aliases` /
 * `kb_chunk_key_aliases` keep old citations alive, but the in-place migration only compares a
 * document's previous generation. If the rebuild produced a fresh database, or if the previous
 * generation's chunk spans several new chunks, some old keys never receive an alias and their
 * `kb://doc/<id>/chunk/<key>` token starts returning 404 even though the text still exists.
 *
 * This script reads the pre-rebuild index as the authority for old chunks, maps every old chunk
 * to the new chunk that contains its start, and (with --apply) writes the missing aliases. Text
 * that was removed or rewritten is deliberately left unmapped: those citations must keep
 * returning 404 instead of opening a neighbouring paragraph.
 *
 * Default mode is a dry run. It writes a JSON report (and optional .sql) but never opens the
 * target for writing. --apply first copies the target to `<index>.bak-alias-repair-<stamp>`.
 *
 * Usage:
 *   node scripts/repair-chunk-key-aliases.mjs --backup old.sqlite --index kb-index.sqlite
 *   node scripts/repair-chunk-key-aliases.mjs --backup old.sqlite --index kb-index.sqlite \
 *     --report /tmp/alias-report.json --sql /tmp/alias-repair.sql --apply
 *
 * Exit codes: 0 = report written (dry run or applied), 1 = mapping/apply failure, 2 = bad usage.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SHINGLE_SIZE = 8
const MIN_SPAN_RATIO = 0.5
const MAX_CANDIDATES = 12
const MAX_SPAN = 20
const SMALL_DOC_PAIR_BUDGET = 20_000

function usage(message) {
  if (message !== undefined) console.error(message)
  console.error('usage: repair-chunk-key-aliases.mjs --backup <old.sqlite> --index <current.sqlite> [--report <json>] [--sql <file>] [--apply] [--only-doc <id>]')
  process.exit(2)
}

function parseArgs(argv) {
  const options = { apply: false, onlyDoc: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined) usage(`missing value for ${arg}`)
      index += 1
      return value
    }
    if (arg === '--backup') options.backup = next()
    else if (arg === '--index') options.index = next()
    else if (arg === '--report') options.report = next()
    else if (arg === '--sql') options.sql = next()
    else if (arg === '--only-doc') options.onlyDoc = Number(next())
    else if (arg === '--apply') options.apply = true
    else if (arg === '--help' || arg === '-h') usage()
    else usage(`unknown argument: ${arg}`)
  }
  if (options.backup === undefined || options.index === undefined) usage('both --backup and --index are required')
  if (options.onlyDoc !== undefined && !Number.isInteger(options.onlyDoc)) usage('--only-doc must be an integer')
  return options
}

const options = parseArgs(process.argv.slice(2))
const backupPath = resolve(options.backup)
const indexPath = resolve(options.index)
const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\..+$/u, '')
const reportPath = resolve(options.report ?? `${indexPath}.alias-repair-report.json`)
const sqlPath = options.sql === undefined ? undefined : resolve(options.sql)

if (!existsSync(backupPath)) usage(`backup not found: ${backupPath}`)
if (!existsSync(indexPath)) usage(`index not found: ${indexPath}`)
if (backupPath === indexPath) usage('backup and index must be different files')

const openReadOnly = path => {
  const db = new DatabaseSync(path, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 10000')
  return db
}

const backup = openReadOnly(backupPath)
const current = openReadOnly(indexPath)

const tableExists = (db, name) => db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
for (const [db, label] of [[backup, 'backup'], [current, 'index']]) {
  for (const table of ['kb_docs', 'kb_chunks', 'kb_chunk_aliases', 'kb_chunk_key_aliases']) {
    if (table === 'kb_chunk_key_aliases' && label === 'backup') continue
    if (!tableExists(db, table)) usage(`${label} is missing table ${table}`)
  }
}

const normalize = value => String(value).replace(/\s+/gu, '')

function shingles(value) {
  const text = normalize(value)
  const out = new Map()
  for (let index = 0; index + SHINGLE_SIZE <= text.length; index += 1) {
    const part = text.slice(index, index + SHINGLE_SIZE)
    out.set(part, (out.get(part) ?? 0) + 1)
  }
  return out
}

function overlapRatio(oldContent, candidateContents) {
  const oldShingles = shingles(oldContent)
  let total = 0
  for (const count of oldShingles.values()) total += count
  if (total === 0) {
    const oldText = oldContent.trim()
    return oldText !== '' && candidateContents.join('\n').trim() === oldText ? 1 : 0
  }
  const candidate = shingles(candidateContents.join('\n'))
  let shared = 0
  for (const [part, count] of oldShingles) shared += Math.min(count, candidate.get(part) ?? 0)
  return shared / total
}

function visibleText(value) {
  return String(value).replace(/<\/?[^>]+>/gu, ' ').replace(/&(?:[a-z]+|#\d+);/giu, ' ')
}

function startAnchor(content) {
  for (const line of content.split('\n')) {
    const text = visibleText(line)
      .replace(/^[\s|]+|[\s|]+$/gu, '')
      .replace(/^\/?[0-9A-Za-z]+\s*>/u, '')
    const normalized = normalize(text)
    if (normalized.length >= 4 && /[0-9A-Za-z\u4e00-\u9fff]/u.test(normalized)) return normalized.slice(0, 24)
  }
  return normalize(visibleText(content)).slice(0, 8)
}

function anchorPosition(content, anchor) {
  return anchor === '' ? -1 : normalize(visibleText(content)).indexOf(anchor)
}

function findCandidate(oldChunk, newChunks, options) {
  const { scanAllAnchors, anchorIndex } = options
  if (!scanAllAnchors) {
    const sameOrd = newChunks[oldChunk.ord ?? -1]
    if (sameOrd !== undefined && sameOrd.content === oldChunk.content) {
      return { chunk: sameOrd, ratio: 1, mode: 'exact', spanChars: normalize(sameOrd.content).length }
    }
  }
  const exact = scanAllAnchors ? newChunks.filter(chunk => chunk.content === oldChunk.content) : []
  if (exact.length > 0) {
    const wanted = oldChunk.ord ?? 0
    const best = exact.reduce((nearest, chunk) => {
      const distance = Math.abs(chunk.line - oldChunk.line)
      const nearestDistance = Math.abs(nearest.line - oldChunk.line)
      if (distance !== nearestDistance) return distance < nearestDistance ? chunk : nearest
      return Math.abs(chunk.ord - wanted) < Math.abs(nearest.ord - wanted) ? chunk : nearest
    })
    return { chunk: best, ratio: 1, mode: 'exact', spanChars: normalize(best.content).length }
  }
  const anchor = startAnchor(oldChunk.content)
  const starts = scanAllAnchors ? [] : [...(anchorIndex.get(anchor) ?? [])]
  if (scanAllAnchors) {
    for (const [index, chunk] of newChunks.entries()) {
      if (anchorPosition(chunk.content, anchor) >= 0) starts.push(index)
    }
  }
  const wanted = oldChunk.ord ?? 0
  let candidates = starts
  if (candidates.length > MAX_CANDIDATES * 2) {
    let low = 0
    let high = candidates.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (candidates[middle] < wanted) low = middle + 1
      else high = middle
    }
    candidates = candidates.slice(Math.max(0, low - MAX_CANDIDATES), low + MAX_CANDIDATES)
  }
  candidates.sort((left, right) => {
    const lineDelta = Math.abs(newChunks[left].line - oldChunk.line) - Math.abs(newChunks[right].line - oldChunk.line)
    return lineDelta !== 0 ? lineDelta : Math.abs(newChunks[left].ord - wanted) - Math.abs(newChunks[right].ord - wanted)
  })
  const oldChars = normalize(oldChunk.content).length
  const maxSpanChars = Math.max(oldChars * 4 + 400, 600)
  let best
  for (const start of candidates.slice(0, MAX_CANDIDATES)) {
    const position = anchorPosition(newChunks[start].content, anchor)
    let spanChars = 0
    let previousRatio = 0
    let stagnant = 0
    for (let end = start; end < Math.min(newChunks.length, start + MAX_SPAN); end += 1) {
      spanChars += normalize(newChunks[end].content).length
      if (spanChars > maxSpanChars) break
      const ratio = overlapRatio(oldChunk.content, newChunks.slice(start, end + 1).map(chunk => chunk.content))
      if (ratio < MIN_SPAN_RATIO) {
        previousRatio = Math.max(previousRatio, ratio)
        continue
      }
      const better = best === undefined || ratio > best.ratio + 0.02
        || (Math.abs(ratio - best.ratio) <= 0.02 && spanChars < best.spanChars)
        || (Math.abs(ratio - best.ratio) <= 0.02 && spanChars === best.spanChars
          && Math.abs(newChunks[start].line - oldChunk.line) < Math.abs(best.chunk.line - oldChunk.line))
        || (Math.abs(ratio - best.ratio) <= 0.02 && spanChars === best.spanChars
          && Math.abs(newChunks[start].line - oldChunk.line) === Math.abs(best.chunk.line - oldChunk.line)
          && position < anchorPosition(best.chunk.content, anchor))
      if (better) best = { chunk: newChunks[start], ratio, mode: 'span', spanChars }
      if (ratio >= 0.999) break
      if (ratio <= previousRatio + 0.02) stagnant += 1
      else stagnant = 0
      previousRatio = Math.max(previousRatio, ratio)
      if (stagnant >= 3 && ratio >= MIN_SPAN_RATIO) break
    }
  }
  if (best !== undefined && scanAllAnchors) {
    const startRatio = overlapRatio(oldChunk.content, [best.chunk.content])
    if (startRatio < 0.1) {
      let single
      for (const chunk of newChunks) {
        const ratio = overlapRatio(oldChunk.content, [chunk.content])
        if (single === undefined || ratio > single.ratio) single = { chunk, ratio }
      }
      if (single !== undefined && single.ratio >= 0.5) {
        return { chunk: single.chunk, ratio: single.ratio, mode: 'single', spanChars: normalize(single.chunk.content).length }
      }
    }
  }
  return best
}

const backupDocs = backup.prepare('SELECT id, path FROM kb_docs ORDER BY id').all()
const currentDocs = current.prepare('SELECT id, path FROM kb_docs ORDER BY id').all()
const currentById = new Map(currentDocs.map(doc => [doc.id, doc]))
const currentByPath = new Map(currentDocs.map(doc => [doc.path, doc]))
const currentChunks = current.prepare('SELECT id, doc_id, ord, line, chunk_key, content FROM kb_chunks ORDER BY doc_id, ord, id').all()
const newByDoc = new Map()
for (const chunk of currentChunks) {
  if (!newByDoc.has(chunk.doc_id)) newByDoc.set(chunk.doc_id, [])
  newByDoc.get(chunk.doc_id).push({ ...chunk, ord: chunk.ord ?? 0, key: chunk.chunk_key })
}
const currentKeys = new Set(currentChunks.map(chunk => `${chunk.doc_id}\u0000${chunk.chunk_key}`))
const keyAliases = new Map()
for (const row of current.prepare('SELECT doc_id, old_chunk_key, chunk_key FROM kb_chunk_key_aliases').all()) {
  keyAliases.set(`${row.doc_id}\u0000${row.old_chunk_key}`, row.chunk_key)
}
const numericAliases = new Map()
for (const row of current.prepare('SELECT doc_id, old_chunk_id, chunk_key FROM kb_chunk_aliases').all()) {
  numericAliases.set(`${row.doc_id}\u0000${row.old_chunk_id}`, row.chunk_key)
}

function resolveKey(docId, startKey) {
  let key = startKey
  for (let hop = 0; hop < 8; hop += 1) {
    if (currentKeys.has(`${docId}\u0000${key}`)) return { state: 'direct', key }
    const next = keyAliases.get(`${docId}\u0000${key}`)
    if (next === undefined || next === key) return { state: keyAliases.has(`${docId}\u0000${key}`) ? 'broken' : 'absent', key }
    key = next
  }
  return { state: 'broken', key }
}

const stats = {
  backupDocs: backupDocs.length,
  currentDocs: currentDocs.length,
  backupChunks: 0,
  backupKeys: 0,
  currentChunks: currentChunks.length,
  existingResolvable: 0,
  existingBroken: 0,
  newlyMapped: 0,
  unmapped: 0,
  docMissing: 0,
  duplicateOldKey: 0,
  existingTargetDiff: 0,
  numericAliasesInserted: 0,
  modes: { exact: 0, span: 0, single: 0 },
}
const mappings = []
const unmapped = []
const conflicts = []
const keyDocs = new Map()

for (const oldDoc of backupDocs) {
  if (options.onlyDoc !== undefined && oldDoc.id !== options.onlyDoc) continue
  const oldChunks = backup.prepare('SELECT id, ord, line, chunk_key, content FROM kb_chunks WHERE doc_id = ? ORDER BY ord, id').all(oldDoc.id)
  stats.backupChunks += oldChunks.length
  const targetDoc = currentById.get(oldDoc.id)?.path === oldDoc.path
    ? currentById.get(oldDoc.id)
    : currentByPath.get(oldDoc.path)
  const newChunks = targetDoc === undefined ? [] : (newByDoc.get(targetDoc.id) ?? [])
  const scanAllAnchors = newChunks.length > 0 && oldChunks.length * newChunks.length <= SMALL_DOC_PAIR_BUDGET
  const anchorIndex = new Map()
  if (!scanAllAnchors) {
    for (const [index, chunk] of newChunks.entries()) {
      const anchor = startAnchor(chunk.content)
      if (anchor === '') continue
      if (!anchorIndex.has(anchor)) anchorIndex.set(anchor, [])
      anchorIndex.get(anchor).push(index)
    }
  }
  for (const oldChunk of oldChunks) {
    if (oldChunk.chunk_key === null || oldChunk.chunk_key === '') continue
    stats.backupKeys += 1
    if (!keyDocs.has(oldChunk.chunk_key)) keyDocs.set(oldChunk.chunk_key, new Set())
    keyDocs.get(oldChunk.chunk_key).add(oldDoc.id)
    if (targetDoc === undefined) {
      stats.docMissing += 1
      stats.unmapped += 1
      unmapped.push({ docId: oldDoc.id, path: oldDoc.path, oldChunkId: oldChunk.id, oldChunkKey: oldChunk.chunk_key, ord: oldChunk.ord, reason: 'document-removed' })
      continue
    }
    const resolved = resolveKey(targetDoc.id, oldChunk.chunk_key)
    if (resolved.state === 'direct' || resolved.state === 'absent') {
      if (resolved.state === 'direct') {
        stats.existingResolvable += 1
        continue
      }
    } else if (resolved.state === 'broken') {
      stats.existingBroken += 1
    }
    const candidate = findCandidate(oldChunk, newChunks, { scanAllAnchors, anchorIndex })
    if (candidate === undefined) {
      stats.unmapped += 1
      unmapped.push({ docId: oldDoc.id, path: oldDoc.path, oldChunkId: oldChunk.id, oldChunkKey: oldChunk.chunk_key, ord: oldChunk.ord, reason: 'content-removed-or-rewritten' })
      continue
    }
    // A working alias is left alone; report when the start-aware matcher would choose another
    // chunk so an operator can opt into a deliberate correction.
    const existingTarget = keyAliases.get(`${targetDoc.id}\u0000${oldChunk.chunk_key}`)
    if (existingTarget !== undefined && existingTarget !== candidate.chunk.key) {
      stats.existingTargetDiff += 1
      if (conflicts.length < 50) {
        conflicts.push({
          docId: targetDoc.id,
          oldChunkKey: oldChunk.chunk_key,
          existingTarget,
          computedTarget: candidate.chunk.key,
          existingOrd: currentChunks.find(chunk => chunk.doc_id === targetDoc.id && chunk.chunk_key === existingTarget)?.ord ?? null,
          computedOrd: candidate.chunk.ord,
          note: 'existing alias resolves; not rewritten by default',
        })
      }
    }
    stats.newlyMapped += 1
    stats.modes[candidate.mode] += 1
    mappings.push({
      docId: targetDoc.id,
      path: oldDoc.path,
      oldChunkId: oldChunk.id,
      oldChunkKey: oldChunk.chunk_key,
      oldOrd: oldChunk.ord,
      newChunkKey: candidate.chunk.key,
      newOrd: candidate.chunk.ord,
      ratio: Number(candidate.ratio.toFixed(4)),
      mode: candidate.mode,
      repairedBrokenAlias: resolved.state === 'broken',
    })
  }
}

for (const [key, docs] of keyDocs) {
  if (docs.size > 1) {
    stats.duplicateOldKey += 1
    if (conflicts.length < 50) conflicts.push({ oldChunkKey: key, docIds: [...docs], note: 'same old key appears in multiple documents; aliases stay doc-scoped' })
  }
}

const sampleKey = process.argv.includes('--sample-key')
  ? process.argv[process.argv.indexOf('--sample-key') + 1]
  : '1fe09e0dbfb4184d'
const sample = mappings.find(row => row.oldChunkKey === sampleKey)
  ?? conflicts.find(row => row.oldChunkKey === sampleKey)
  ?? null

const sqlStatements = []
for (const row of mappings) {
  sqlStatements.push(`INSERT INTO kb_chunk_key_aliases(doc_id, old_chunk_key, chunk_key, overlap) VALUES (${row.docId}, ${quoteSql(row.oldChunkKey)}, ${quoteSql(row.newChunkKey)}, ${row.ratio}) ON CONFLICT(doc_id, old_chunk_key) DO UPDATE SET chunk_key = excluded.chunk_key, overlap = excluded.overlap;`)
  sqlStatements.push(`INSERT INTO kb_chunk_aliases(doc_id, old_chunk_id, chunk_key) VALUES (${row.docId}, ${row.oldChunkId}, ${quoteSql(row.newChunkKey)}) ON CONFLICT(doc_id, old_chunk_id) DO UPDATE SET chunk_key = excluded.chunk_key;`)
}

function quoteSql(value) {
  return `'${String(value).replace(/'/gu, "''")}'`
}

let applyResult = null
if (options.apply) {
  const backupCopy = `${indexPath}.bak-alias-repair-${stamp}`
  if (existsSync(backupCopy)) throw new Error(`backup copy already exists: ${backupCopy}`)
  // VACUUM INTO produces a consistent snapshot including WAL contents; copying the main file
  // alone would miss committed pages that still live in -wal.
  current.exec(`VACUUM INTO '${backupCopy.replace(/'/gu, "''")}'`)
  const writable = new DatabaseSync(indexPath)
  writable.exec('PRAGMA busy_timeout = 10000')
  try {
    writable.exec('BEGIN IMMEDIATE')
    const insertKey = writable.prepare('INSERT INTO kb_chunk_key_aliases(doc_id, old_chunk_key, chunk_key, overlap) VALUES (?, ?, ?, ?) ON CONFLICT(doc_id, old_chunk_key) DO UPDATE SET chunk_key = excluded.chunk_key, overlap = excluded.overlap')
    const insertNumeric = writable.prepare('INSERT INTO kb_chunk_aliases(doc_id, old_chunk_id, chunk_key) VALUES (?, ?, ?) ON CONFLICT(doc_id, old_chunk_id) DO UPDATE SET chunk_key = excluded.chunk_key')
    for (const row of mappings) {
      insertKey.run(row.docId, row.oldChunkKey, row.newChunkKey, row.ratio)
      insertNumeric.run(row.docId, row.oldChunkId, row.newChunkKey)
      stats.numericAliasesInserted += 1
    }
    writable.exec('COMMIT')
    const checks = []
    const verifyRows = mappings.filter(row => row.oldChunkKey === sampleKey || row.oldChunkKey === '894b6329ee76385e')
    for (const row of verifyRows.slice(0, 10)) {
      const hit = writable.prepare(`SELECT c.chunk_key, c.ord, c.content FROM kb_chunk_key_aliases a JOIN kb_chunks c ON c.doc_id = a.doc_id AND c.chunk_key = a.chunk_key WHERE a.doc_id = ? AND a.old_chunk_key = ?`).get(row.docId, row.oldChunkKey)
      checks.push({ docId: row.docId, oldChunkKey: row.oldChunkKey, target: hit === undefined ? null : { chunkKey: hit.chunk_key, ord: hit.ord, preview: String(hit.content).replace(/\s+/gu, ' ').slice(0, 80) } })
    }
    applyResult = { backupCopy, applied: mappings.length, checks }
  } catch (error) {
    try { writable.exec('ROLLBACK') } catch { /* already rolled back */ }
    throw error
  } finally {
    writable.close()
  }
}

backup.close()
current.close()

const report = {
  generatedAt: new Date().toISOString(),
  backupPath,
  indexPath,
  dryRun: !options.apply,
  stats,
  sample,
  mappings,
  unmapped,
  conflicts,
  apply: applyResult,
}
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
if (sqlPath !== undefined) {
  writeFileSync(sqlPath, ['BEGIN IMMEDIATE;', ...sqlStatements, 'COMMIT;', ''].join('\n'))
}

console.log(JSON.stringify({
  dryRun: !options.apply,
  report: reportPath,
  sql: sqlPath ?? null,
  stats,
  sample,
  apply: applyResult,
}, null, 2))