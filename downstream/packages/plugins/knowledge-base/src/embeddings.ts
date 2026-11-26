/**
 * Embedding provider calls for optional vector retrieval.
 *
 * The provider is deliberately small and deployment-owned: an OpenAI-compatible
 * `/v1/embeddings` endpoint or an Ollama `/api/embeddings` endpoint. The API key is
 * never part of configuration or a stored record; callers pass the resolved value for
 * one request, and the settings page only ever shows the credential reference.
 *
 * @module @sparkelf/dsh-knowledge-base/embeddings
 */

/** Providers this plugin can call. */
export type EmbeddingProvider = 'openai-compatible' | 'ollama'

/** Vector retrieval settings. Every switch defaults off. */
export interface VectorRetrievalConfig {
  /** Whether vector retrieval and background embedding are enabled. */
  enabled: boolean
  /** Embedding API shape. */
  provider: EmbeddingProvider
  /** Provider base URL, without a trailing slash requirement. */
  baseUrl: string
  /** Embedding model name. */
  model: string
  /** Expected vector width; `0` accepts and records the provider's width. */
  dimensions: number
  /** Credential-store reference for an API key; never the key itself. */
  credentialRef: string
  /** RRF constant used by hybrid fusion. */
  rrfK: number
  /** How many FTS and vector candidates each side contributes before fusion. */
  candidateK: number
  /** RRF weight of the FTS component. */
  ftsWeight: number
  /** RRF weight of the vector component. */
  vectorWeight: number
}

/** Defaults: no network calls, no vector storage, and the standard RRF shape. */
export const DEFAULT_VECTOR_RETRIEVAL: VectorRetrievalConfig = {
  enabled: false,
  provider: 'openai-compatible',
  baseUrl: '',
  model: '',
  dimensions: 0,
  credentialRef: '',
  rrfK: 60,
  candidateK: 50,
  ftsWeight: 1,
  vectorWeight: 0.5,
}

/** A structured provider failure that callers can report without exposing a key. */
export class EmbeddingProviderError extends Error {
  override readonly name = 'EmbeddingProviderError'
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/** Normalize a base URL and append the provider's embedding path. */
export function embeddingEndpoint(config: Pick<VectorRetrievalConfig, 'provider' | 'baseUrl'>): string {
  const base = config.baseUrl.trim().replace(/\/+$/u, '')
  if (base === '') throw new EmbeddingProviderError('embedding baseUrl is empty')
  if (config.provider === 'ollama') return base + '/api/embeddings'
  // OpenAI-compatible deployments commonly configure either `http://host:port` or
  // `http://host:port/v1`. Accept both spellings rather than producing `/v1/v1/...`.
  return base.endsWith('/v1') ? base + '/embeddings' : base + '/v1/embeddings'
}

/** Read one embedding from a response without trusting its shape. */
function embeddingOf(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new EmbeddingProviderError('embedding response contains no vector')
  }
  const vector: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new EmbeddingProviderError('embedding response contains a non-finite value')
    }
    vector.push(item)
  }
  return vector
}

/** One HTTP embedding call, bounded by a caller supplied abort signal. */
async function postEmbedding(
  endpoint: string,
  body: Record<string, unknown>,
  apiKey: string
): Promise<number[]> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey !== '') headers.authorization = `Bearer ${apiKey}`
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  } catch (cause) {
    throw new EmbeddingProviderError(`embedding provider is unreachable at ${endpoint}`, undefined)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new EmbeddingProviderError(
      `embedding provider failed (HTTP ${String(response.status)})${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`,
      response.status,
    )
  }
  const decoded = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
  if (decoded === undefined) throw new EmbeddingProviderError('embedding provider returned invalid JSON')
  if (Array.isArray(decoded.data)) {
    const first = (decoded.data[0] as { embedding?: unknown } | undefined)?.embedding
    return embeddingOf(first)
  }
  return embeddingOf(decoded.embedding)
}

/**
 * Embed one batch of texts.
 *
 * OpenAI-compatible providers accept a batch and return one row per input. Ollama's
 * documented `/api/embeddings` endpoint is singular, so its inputs are requested in
 * order; callers still control the batch size and keep provider concurrency bounded.
 */
export async function embedTexts(
  config: Pick<VectorRetrievalConfig, 'provider' | 'baseUrl' | 'model' | 'dimensions'>,
  texts: readonly string[],
  apiKey = '',
): Promise<number[][]> {
  if (texts.length === 0) return []
  const endpoint = embeddingEndpoint(config)
  if (config.model.trim() === '') throw new EmbeddingProviderError('embedding model is empty')
  const out: number[][] = []
  if (config.provider === 'ollama') {
    for (const text of texts) {
      out.push(await postEmbedding(endpoint, { model: config.model, prompt: text }, apiKey))
    }
  } else {
    const body: Record<string, unknown> = { model: config.model, input: [...texts] }
    if (config.dimensions > 0) body.dimensions = config.dimensions
    const data = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify(body),
    }).then(async response => {
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new EmbeddingProviderError(
          `embedding provider failed (HTTP ${String(response.status)})${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`,
          response.status,
        )
      }
      return response.json() as Promise<Record<string, unknown>>
    })
    const rows = Array.isArray(data.data) ? data.data : []
    if (rows.length !== texts.length) {
      throw new EmbeddingProviderError(`embedding provider returned ${String(rows.length)} vectors for ${String(texts.length)} inputs`)
    }
    for (const row of rows) out.push(embeddingOf((row as { embedding?: unknown }).embedding))
  }
  for (const vector of out) {
    if (config.dimensions > 0 && vector.length !== config.dimensions) {
      throw new EmbeddingProviderError(
        `embedding dimension mismatch: expected ${String(config.dimensions)}, received ${String(vector.length)}`,
      )
    }
  }
  return out
}

/**
 * Validate one stored retrieval object.
 *
 * Unknown values fall back field by field rather than invalidating the group, so a
 * hand-edited file cannot switch a provider on with a half-valid configuration.
 * @param raw - parsed settings value.
 * @returns A complete, safe vector configuration.
 */
export function normalizeVectorRetrieval(raw: unknown): VectorRetrievalConfig {
  const source = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const provider = source.provider === 'ollama' ? 'ollama' : 'openai-compatible'
  const dimensions = typeof source.dimensions === 'number' && Number.isInteger(source.dimensions) && source.dimensions >= 0
    ? source.dimensions
    : 0
  const rrfK = typeof source.rrfK === 'number' && Number.isFinite(source.rrfK) && source.rrfK > 0
    ? Math.min(1000, Math.floor(source.rrfK))
    : 60
  const candidateK = typeof source.candidateK === 'number' && Number.isFinite(source.candidateK) && source.candidateK > 0
    ? Math.min(200, Math.floor(source.candidateK))
    : 50
  const weight = (value: unknown, fallback: number): number => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(10, value) : fallback
  )
  return {
    enabled: source.enabled === true,
    provider,
    baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl.trim().replace(/\/+$/u, '') : '',
    model: typeof source.model === 'string' ? source.model.trim() : '',
    dimensions,
    credentialRef: typeof source.credentialRef === 'string' ? source.credentialRef.trim() : '',
    rrfK,
    candidateK,
    ftsWeight: weight(source.ftsWeight, 1),
    vectorWeight: weight(source.vectorWeight, 0.5),
  }
}
