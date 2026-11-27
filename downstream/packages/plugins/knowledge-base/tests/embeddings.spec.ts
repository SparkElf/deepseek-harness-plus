import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_VECTOR_RETRIEVAL,
  EmbeddingProviderError,
  embedTexts,
  normalizeVectorRetrieval,
} from '../src/embeddings.ts'
import { readStorageSettings, writeStorageSettings } from '../src/views.ts'

afterEach(async () => {
  vi.unstubAllGlobals()
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})
const roots: string[] = []

describe('vector settings', () => {
  it('defaults off and normalizes invalid fields field by field', () => {
    expect(DEFAULT_VECTOR_RETRIEVAL.enabled).toBe(false)
    const normalized = normalizeVectorRetrieval({
      enabled: true,
      provider: 'ollama',
      baseUrl: ' http://host:11434/ ',
      model: ' m ',
      dimensions: 768,
      credentialRef: 'REF',
      rrfK: 42,
      candidateK: 20,
      ftsWeight: 2,
      vectorWeight: 0.25,
    })
    expect(normalized).toMatchObject({
      enabled: true, provider: 'ollama', baseUrl: 'http://host:11434', model: 'm',
      dimensions: 768, credentialRef: 'REF', rrfK: 42, candidateK: 20, ftsWeight: 2, vectorWeight: 0.25,
    })
    expect(normalizeVectorRetrieval({ dimensions: -1, rrfK: 0, candidateK: 0 }).dimensions).toBe(0)
  })

  it('stores only the credential reference, never a supplied secret', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-vector-settings-'))
    roots.push(root)
    await writeStorageSettings(root, {
      retrieval: {
        vector: {
          ...DEFAULT_VECTOR_RETRIEVAL,
          enabled: true,
          credentialRef: 'KB_EMBEDDING_KEY',
          apiKey: 'sk-should-not-be-stored',
        } as never,
      },
    })
    const settings = await readStorageSettings(root)
    expect(settings.retrieval?.vector.credentialRef).toBe('KB_EMBEDDING_KEY')
    const raw = await readFile(join(root, '.kb-settings.json'), 'utf8')
    expect(raw).not.toContain('sk-should-not-be-stored')
  })
})

describe('embedding provider', () => {
  it('calls the OpenAI-compatible endpoint with the resolved key and dimensions', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[]; dimensions: number }
      expect(body.input).toEqual(['a', 'b'])
      expect(body.dimensions).toBe(2)
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer secret')
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const vectors = await embedTexts({
      provider: 'openai-compatible', baseUrl: 'http://provider/v1', model: 'm', dimensions: 2,
    }, ['a', 'b'], 'secret')
    expect(vectors).toEqual([[1, 0], [0, 1]])
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('http://provider/v1/embeddings')
  })

  it('surfaces a provider failure instead of returning an empty vector', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream down', { status: 503 })))
    await expect(embedTexts({
      provider: 'openai-compatible', baseUrl: 'http://provider', model: 'm', dimensions: 0,
    }, ['a'])).rejects.toBeInstanceOf(EmbeddingProviderError)
  })
})
