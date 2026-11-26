#!/usr/bin/env node
/**
 * Remap an eval dataset's required_chunks to a rebuilt KB index.
 *
 * Structure-aware chunking changes chunk ids. Each dataset claim keeps its original
 * quote; this script finds the new chunk whose content contains that quote and adds
 * chunkId/docId/citation/chunkOrdinal/chunk_quote. Unmatched claims are reported and
 * left untouched rather than silently pointing at a different passage.
 *
 * Usage: node scripts/remap-dataset-chunks.mjs <dataset.jsonl> <kb-index.sqlite> <out.jsonl>
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'

const [datasetPath, indexPath, outPath] = process.argv.slice(2)
if (datasetPath === undefined || indexPath === undefined || outPath === undefined) {
  console.error('usage: remap-dataset-chunks.mjs <dataset.jsonl> <kb-index.sqlite> <out.jsonl>')
  process.exit(2)
}
const normalize = value => String(value).replace(/<!--[\s\S]*?-->/gu, ' ').replace(/[#*_`~|]/gu, ' ').replace(/\b[A-Z]{1,3}\d+\b/gu, ' ').replace(/\s+/gu, '')
const db = new DatabaseSync(indexPath)
const docs = db.prepare('SELECT id, path, source_path FROM kb_docs').all()
const matchDoc = (candidate) => {
  const path = String(candidate ?? '').replace(/^\/workspace\/kb\//u, '').replace(/^global\//u, '')
  const name = path.split('/').pop()
  return docs.find(doc => doc.source_path === path || doc.path === path || doc.path === path + '.md'
    || doc.source_path?.split('/').pop() === name || doc.path?.split('/').pop() === name + '.md')
}
const chunksFor = db.prepare('SELECT id, doc_id, ord, content FROM kb_chunks WHERE doc_id = ? ORDER BY ord, id')
let total = 0; let matched = 0
const rows = readFileSync(datasetPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
for (const row of rows) {
  for (const claim of row.required_chunks ?? []) {
    total += 1
    const doc = matchDoc(claim.path ?? claim.original_path ?? claim.doc)
    if (doc === undefined) continue
    const needle = normalize(claim.quote ?? claim.locator?.quote ?? '')
    if (needle === '') continue
    const hit = chunksFor.all(doc.id).find(chunk => normalize(chunk.content).includes(needle))
    if (hit === undefined) continue
    claim.chunkId = hit.id
    claim.chunk_id = hit.id
    claim.docId = doc.id
    claim.chunkOrdinal = hit.ord
    claim.citation = `kb://doc/${String(doc.id)}/chunk/${String(hit.id)}`
    claim.chunk_quote = String(hit.content).replace(/\s+/gu, ' ').trim().slice(0, 420)
    matched += 1
  }
}
db.close()
writeFileSync(outPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
console.log(JSON.stringify({ total, matched, unmatched: total - matched, out: outPath }))
