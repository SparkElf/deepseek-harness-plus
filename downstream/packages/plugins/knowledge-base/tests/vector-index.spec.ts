import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { indexPathFor, searchIndex, syncIndex } from '../src/ftsIndex.ts'
import {
  cosineSimilarity,
  ensureVectorSchema,
  packVector,
  putEmbedding,
  unpackVector,
  vectorIndexStats,
  vectorNorm,
} from '../src/vectorIndex.ts'

const roots: string[] = []
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-vector-'))
  roots.push(root)
  const actual = join(root, 'actual')
  const indexPath = indexPathFor(join(root, 'index'))
  await mkdir(join(actual, 'global'), { recursive: true })
  return { actual, indexPath }
}
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

/** Insert a vector for the first chunk of one document path. */
function embedDoc(indexPath: string, path: string, vector: number[], model = 'test-model'): void {
  const db = new DatabaseSync(indexPath)
  try {
    ensureVectorSchema(db)
    const row = db.prepare('SELECT c.id AS id, c.doc_id AS docId, c.content AS content FROM kb_chunks c WHERE c.path = ? ORDER BY c.id LIMIT 1')
      .get(path) as { id: number; docId: number; content: string } | undefined
    if (row === undefined) throw new Error(`no chunk for ${path}`)
    putEmbedding(db, {
      chunkId: row.id,
      docId: row.docId,
      path,
      model,
      vector,
      contentHash: 'test-hash-' + String(row.id),
      updatedAt: new Date().toISOString(),
    })
  } finally {
    db.close()
  }
}

describe('vector sidecar BLOB and cosine', () => {
  it('round-trips Float32 bytes and computes cosine similarity', () => {
    const vector = [0.25, -1, 2.5, 0]
    const decoded = unpackVector(packVector(vector))
    expect([...decoded]).toEqual(vector)
    const norm = vectorNorm(vector)
    expect(norm).toBeCloseTo(Math.sqrt(0.0625 + 1 + 6.25), 8)
    expect(cosineSimilarity([1, 0], [1, 0], 1, 1)).toBe(1)
    expect(cosineSimilarity([1, 0], [0, 1], 1, 1)).toBe(0)
    expect(cosineSimilarity([1, 0], [-1, 0], 1, 1)).toBe(-1)
  })

  it('reports coverage counts', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/a.md'), '# A\n\nkeyword alpha')
    await syncIndex({ actualRoot: actual, indexPath })
    expect(vectorIndexStats(new DatabaseSync(indexPath), 'test-model').totalDocs).toBe(1)
    embedDoc(indexPath, 'global/a.md', [1, 0])
    const stats = vectorIndexStats(new DatabaseSync(indexPath), 'test-model')
    expect(stats.embeddedChunks).toBe(1)
    expect(stats.embeddedDocs).toBe(1)
  })
})

describe('hybrid RRF', () => {
  it('keeps a keyword-only document when the only vector hit is vector-only', async () => {
    const { actual, indexPath } = await fixture()
    // A is the strong keyword hit and has no vector.
    await writeFile(join(actual, 'global/a.md'), '# Alpha\n\nuniquekeyword alpha only')
    // B is semantically similar but has no keyword match.
    await writeFile(join(actual, 'global/b.md'), '# Beta\n\nsemantic vector only')
    await syncIndex({ actualRoot: actual, indexPath })
    embedDoc(indexPath, 'global/b.md', [1, 0])
    const result = await searchIndex({
      indexPath,
      query: 'uniquekeyword',
      topK: 1,
      caller: { callerId: 'u1', departmentCodes: [], global: true },
      canRead: async () => true,
      vector: {
        model: 'test-model',
        queryVector: [1, 0],
        candidateK: 10,
        rrfK: 60,
        // Deliberately make the vector component dominate so the floor, not the
        // default weights, is what restores the keyword-only document.
        ftsWeight: 0.1,
        vectorWeight: 10,
        coverage: 1,
      },
    })
    expect(result.hits[0]?.path).toBe('global/a.md')
    expect(result.hits[0]?.retrieval).toBe('fts')
    expect(result.hits[0]?.retrievalReason).toBe('fts-floor')
    expect(result.floorReplacements).toBe(1)
  })

  it('returns both channels when both fit in topK', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/a.md'), '# Alpha\n\nuniquekeyword alpha only')
    await writeFile(join(actual, 'global/b.md'), '# Beta\n\nsemantic vector only')
    await syncIndex({ actualRoot: actual, indexPath })
    embedDoc(indexPath, 'global/b.md', [1, 0])
    const result = await searchIndex({
      indexPath,
      query: 'uniquekeyword',
      topK: 2,
      caller: { callerId: 'u1', departmentCodes: [], global: true },
      canRead: async () => true,
      vector: {
        model: 'test-model',
        queryVector: [1, 0],
        candidateK: 10,
        rrfK: 60,
        ftsWeight: 1,
        vectorWeight: 0.5,
        coverage: 0.5,
      },
    })
    expect(result.hits.map(hit => hit.path)).toEqual(['global/a.md', 'global/b.md'])
    expect(result.hits.find(hit => hit.path === 'global/a.md')?.retrieval).toBe('fts')
    expect(result.hits.find(hit => hit.path === 'global/b.md')?.retrieval).toBe('vector')
    expect(result.hits.find(hit => hit.path === 'global/b.md')?.vectorRank).toBe(1)
  })

  it('is exactly FTS when no document has a vector', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/a.md'), '# Alpha\n\nuniquekeyword')
    await syncIndex({ actualRoot: actual, indexPath })
    const result = await searchIndex({
      indexPath,
      query: 'uniquekeyword',
      topK: 5,
      caller: { callerId: 'u1', departmentCodes: [], global: true },
      canRead: async () => true,
      vector: {
        model: 'test-model',
        queryVector: [1, 0],
        candidateK: 10,
        rrfK: 60,
        ftsWeight: 1,
        vectorWeight: 0.5,
        coverage: 0,
      },
    })
    expect(result.hits).toHaveLength(1)
    expect(result.retrieval).toBe('fts')
    expect(result.hits[0]?.retrieval).toBeUndefined()
  })

  it('leaves pure FTS results untouched when vector is absent', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/a.md'), '# Alpha\n\nuniquekeyword')
    await syncIndex({ actualRoot: actual, indexPath })
    const result = await searchIndex({
      indexPath,
      query: 'uniquekeyword',
      topK: 5,
      caller: { callerId: 'u1', departmentCodes: [], global: true },
      canRead: async () => true,
    })
    expect(result.retrieval).toBeUndefined()
    expect(result.hits[0]?.retrieval).toBeUndefined()
    expect(result.hits[0]?.score).toBeGreaterThan(0)
  })
})
