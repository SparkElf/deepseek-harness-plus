/**
 * Optional SQLite vector sidecar for hybrid retrieval.
 *
 * Vectors are stored as raw Float32 blobs in the same SQLite file as the FTS index.
 * No sqlite-vec extension is required: candidate rows are read into the process and
 * cosine similarity is computed here. The table is keyed by the current chunk id, so
 * a re-chunk simply makes an old row unreachable until it is pruned.
 *
 * @module @sparkelf/dsh-knowledge-base/vectorIndex
 */

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

/** One stored embedding row. */
export interface VectorEmbeddingRow {
  chunkId: number
  docId: number
  path: string
  model: string
  dim: number
  vector: Float32Array
  norm: number
  contentHash: string
}

/** One chunk that needs an embedding. */
export interface VectorChunk {
  id: number
  docId: number
  path: string
  content: string
}

/** Counts for the settings page. */
export interface VectorIndexStats {
  totalChunks: number
  embeddedChunks: number
  totalDocs: number
  embeddedDocs: number
  failed: number
  model: string
}

/** Create the vector tables in an existing index database. */
export function ensureVectorSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_embeddings (
      chunk_id INTEGER PRIMARY KEY,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      norm REAL NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS kb_embeddings_model ON kb_embeddings(model);
    CREATE TABLE IF NOT EXISTS kb_vector_failures (
      chunk_id INTEGER PRIMARY KEY,
      doc_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      model TEXT NOT NULL,
      error TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS kb_vector_failures_model ON kb_vector_failures(model);
  `)
}

/** Stable content key used to decide whether an embedding is stale. */
export function embeddingContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** L2 norm of a vector; zero vectors cannot be normalized and are never stored. */
export function vectorNorm(vector: ArrayLike<number>): number {
  let sum = 0
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] as number
    sum += value * value
  }
  return Math.sqrt(sum)
}

/** Serialize a vector as little-endian Float32 bytes. */
export function packVector(vector: ArrayLike<number>): Buffer {
  const values = Float32Array.from(vector)
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength)
}

/** Deserialize a Float32 blob without copying the bytes. */
export function unpackVector(blob: Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) throw new Error('corrupt embedding blob: byte length is not a multiple of four')
  const copy = new Uint8Array(blob)
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4)
}

/** Cosine similarity; both norms are precomputed for stored rows. */
export function cosineSimilarity(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  leftNorm: number,
  rightNorm: number,
): number {
  if (left.length !== right.length || leftNorm <= 0 || rightNorm <= 0) return 0
  let dot = 0
  for (let index = 0; index < left.length; index += 1) dot += (left[index] as number) * (right[index] as number)
  return dot / (leftNorm * rightNorm)
}

/** Upsert one embedding and clear its previous failure. */
export function putEmbedding(
  db: DatabaseSync,
  row: {
    chunkId: number
    docId: number
    path: string
    model: string
    vector: readonly number[]
    contentHash: string
    updatedAt: string
  },
): void {
  const norm = vectorNorm(row.vector)
  if (norm <= 0) throw new Error('embedding vector has zero norm')
  db.prepare(`
    INSERT INTO kb_embeddings(chunk_id, model, dim, vector, norm, content_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chunk_id) DO UPDATE SET
      model = excluded.model,
      dim = excluded.dim,
      vector = excluded.vector,
      norm = excluded.norm,
      content_hash = excluded.content_hash,
      updated_at = excluded.updated_at
  `).run(row.chunkId, row.model, row.vector.length, packVector(row.vector), norm, row.contentHash, row.updatedAt)
  db.prepare('DELETE FROM kb_vector_failures WHERE chunk_id = ?').run(row.chunkId)
}

/** Record a per-chunk failure without pretending a vector exists. */
export function recordVectorFailure(
  db: DatabaseSync,
  row: { chunkId: number; docId: number; path: string; model: string; error: string; updatedAt: string },
): void {
  db.prepare(`
    INSERT INTO kb_vector_failures(chunk_id, doc_id, path, model, error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chunk_id) DO UPDATE SET
      doc_id = excluded.doc_id,
      path = excluded.path,
      model = excluded.model,
      error = excluded.error,
      updated_at = excluded.updated_at
  `).run(row.chunkId, row.docId, row.path, row.model, row.error.slice(0, 1000), row.updatedAt)
}

/** Read chunks for a set of documents. */
export function chunksForDocuments(db: DatabaseSync, docIds: readonly number[]): VectorChunk[] {
  if (docIds.length === 0) return []
  const placeholders = docIds.map(() => '?').join(',')
  return (db.prepare(`
    SELECT id, doc_id AS docId, path, content
    FROM kb_chunks WHERE doc_id IN (${placeholders}) ORDER BY doc_id, ord, id
  `).all(...docIds) as Array<{ id: number; docId: number; path: string; content: string }>).map(row => ({
    id: row.id,
    docId: row.docId,
    path: row.path,
    content: row.content,
  }))
}

/** Current embedding state for chunks, keyed by chunk id. */
export function embeddingStates(db: DatabaseSync, model: string, chunkIds: readonly number[]): Map<number, { contentHash: string; model: string }> {
  const out = new Map<number, { contentHash: string; model: string }>()
  if (chunkIds.length === 0) return out
  const placeholders = chunkIds.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT chunk_id AS chunkId, content_hash AS contentHash, model
    FROM kb_embeddings WHERE model = ? AND chunk_id IN (${placeholders})
  `).all(model, ...chunkIds) as Array<{ chunkId: number; contentHash: string; model: string }>
  for (const row of rows) out.set(row.chunkId, { contentHash: row.contentHash, model: row.model })
  return out
}

/** Stats for the settings page, optionally for one model. */
export function vectorIndexStats(db: DatabaseSync, model: string): VectorIndexStats {
  const totalChunks = Number((db.prepare('SELECT COUNT(*) AS n FROM kb_chunks').get() as { n: number }).n)
  const totalDocs = Number((db.prepare('SELECT COUNT(*) AS n FROM kb_docs').get() as { n: number }).n)
  const embedded = db.prepare(`
    SELECT COUNT(*) AS n, COUNT(DISTINCT c.doc_id) AS docs
    FROM kb_embeddings e JOIN kb_chunks c ON c.id = e.chunk_id
    WHERE e.model = ?
  `).get(model) as { n: number; docs: number }
  const failed = Number((db.prepare('SELECT COUNT(*) AS n FROM kb_vector_failures WHERE model = ?').get(model) as { n: number }).n)
  return {
    totalChunks,
    embeddedChunks: Number(embedded.n),
    totalDocs,
    embeddedDocs: Number(embedded.docs),
    failed,
    model,
  }
}

/** One vector candidate row before fuse. */
export interface VectorCandidate {
  chunkId: number
  docId: number
  path: string
  score: number
}

/**
 * Read every current embedding for a model and rank it by cosine similarity.
 *
 * Scope filtering is applied in SQL before similarity ordering, exactly as the FTS
 * side does. A caller-supplied `canRead` check still runs on the resulting paths.
 */
export function vectorCandidates(
  db: DatabaseSync,
  options: {
    model: string
    query: readonly number[]
    clauses: readonly string[]
    params: readonly (string | number)[]
    scopeClause: string
    scopeParams: readonly (string | number)[]
    candidateK: number
  },
): VectorCandidate[] {
  const queryNorm = vectorNorm(options.query)
  if (queryNorm <= 0) return []
  const rows = db.prepare(`
    SELECT e.chunk_id AS chunkId, c.doc_id AS docId, c.path AS path, e.vector AS vector, e.norm AS norm
    FROM kb_embeddings e
    JOIN kb_chunks c ON c.id = e.chunk_id
    JOIN kb_docs d ON d.id = c.doc_id
    WHERE e.model = ? AND (${options.clauses.join(' OR ')})${options.scopeClause}
  `).all(options.model, ...options.params, ...options.scopeParams) as Array<{
    chunkId: number
    docId: number
    path: string
    vector: Uint8Array
    norm: number
  }>
  return rows
    .map(row => {
      const vector = unpackVector(row.vector)
      return {
        chunkId: row.chunkId,
        docId: row.docId,
        path: row.path,
        score: cosineSimilarity(options.query, vector, queryNorm, row.norm),
      }
    })
    .filter(row => row.score > 0)
    .sort((left, right) => right.score - left.score || left.chunkId - right.chunkId)
    .slice(0, Math.max(1, options.candidateK))
}

/** One document target for an explicit vectorization run. */
export interface VectorDocument {
  id: number
  path: string
  scope: string
}

/** Resolve explicit targets by id or path prefix, optionally narrowed by scope. */
export function vectorDocuments(
  db: DatabaseSync,
  target: { docId?: number; path?: string; scope?: string; all?: boolean },
): VectorDocument[] {
  const clauses: string[] = []
  const params: Array<string | number> = []
  if (target.docId !== undefined) {
    clauses.push('id = ?')
    params.push(target.docId)
  }
  if (target.path !== undefined && target.path !== '') {
    // A file path matches exactly; a directory matches itself (for a directory-shaped
    // document path) and every descendant. Callers pass view-relative paths.
    clauses.push('(path = ? OR path LIKE ?)')
    params.push(target.path, target.path.replace(/\/+$/u, '') + '/%')
  }
  if (target.scope === 'personal' || target.scope === 'department' || target.scope === 'global') {
    clauses.push('scope = ?')
    params.push(target.scope)
  }
  if (target.all === true && clauses.length === 0) return db.prepare('SELECT id, path, scope FROM kb_docs ORDER BY path, id').all() as unknown as VectorDocument[]
  if (clauses.length === 0) return []
  return db.prepare(`SELECT id, path, scope FROM kb_docs WHERE ${clauses.join(' AND ')} ORDER BY path, id`)
    .all(...params) as unknown as VectorDocument[]
}
