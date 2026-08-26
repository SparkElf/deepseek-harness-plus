/** Optional external document-parser capability (`ctx.documentParser`). @module @deepseek-ai/dsh-document-parser */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { DocumentParseRequest, DocumentParseResult, DocumentParserProvider } from './types.ts'
import { DocumentParserError } from './error.ts'

export { DocumentParserError } from './error.ts'
export type {
  DocumentParseRequest,
  DocumentParseResult,
  DocumentParserErrorCode,
  DocumentParserProvider,
  ParsedDocumentImage,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    documentParser: DocumentParserRuntime
  }
}

/** Deployment choices owned by the provider-neutral parser seam. */
export interface Config {
  /** Explicit parser provider id; omission auto-selects exactly one registered provider. */
  provider?: string
  /** Maximum aggregate rendered-document bytes, including delimiters and metadata, accepted for direct-context version one. */
  maxDirectMarkdownBytes: number
}

/** Parser seam configuration; the direct-context budget is intentionally required. */
export const Config: z<Config> = z.object({
  provider: z.string(),
  maxDirectMarkdownBytes: z.number().step(1).min(1).required(),
})

/** Provider-neutral parser registry and direct-context policy owner. */
export class DocumentParserRuntime extends Service {
  private providers = new Map<string, DocumentParserProvider>()
  private readonly providerId: string | undefined
  /** Maximum aggregate rendered-document bytes Host admission may attach in one submitted message. */
  readonly maxDirectMarkdownBytes: number

  constructor(ctx: Context, config: Config) {
    super(ctx, 'documentParser')
    if (!Number.isSafeInteger(config.maxDirectMarkdownBytes) || config.maxDirectMarkdownBytes <= 0) {
      throw new Error('document-parser: maxDirectMarkdownBytes must be a positive safe integer')
    }
    if (config.provider !== undefined && config.provider.length === 0) {
      throw new Error('document-parser: configured provider id must be non-empty')
    }
    this.providerId = config.provider
    this.maxDirectMarkdownBytes = config.maxDirectMarkdownBytes
  }

  /**
   * Register one parser provider until the owning Cordis fiber disposes.
   * @param provider - provider implementation keyed by its non-empty id.
   * @returns disposer that withdraws exactly this registration.
   */
  registerProvider(provider: DocumentParserProvider): () => void {
    if (provider.id.length === 0) throw new Error('document-parser: provider id must be non-empty')
    if (this.providers.has(provider.id)) {
      throw new DocumentParserError(
        `a document parser provider with id "${provider.id}" is already registered`,
        'DOCUMENT_PARSER_DUPLICATE_PROVIDER',
      )
    }
    const providers = this.providers
    const providerId = provider.id
    const dispose = this.ctx.effect(function* () {
      providers.set(providerId, provider)
      yield () => providers.delete(providerId)
    }, 'documentParser.registerProvider()')
    return () => void dispose()
  }

  /**
   * Report whether current registry state resolves the configured provider selection.
   * This does not probe provider health or external endpoint availability.
   * @returns true only when a parse call can select exactly one registered provider.
   */
  isSelectionResolvable(): boolean {
    if (this.providerId !== undefined) return this.providers.has(this.providerId)
    return this.providers.size === 1
  }

  /**
   * Parse one already-persisted document through the deployment-selected provider.
   * @param request - verified original bytes and their durable metadata.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns provider id together with the complete transient parse bundle.
   */
  async parse(
    request: DocumentParseRequest,
    signal?: AbortSignal,
  ): Promise<{ parser: string; result: DocumentParseResult }> {
    const provider = this.resolveProvider()
    return { parser: provider.id, result: await provider.parse(request, signal) }
  }

  private resolveProvider(): DocumentParserProvider {
    if (this.providerId !== undefined) {
      const provider = this.providers.get(this.providerId)
      if (provider === undefined) {
        throw new DocumentParserError(
          `configured document parser provider "${this.providerId}" is not registered`,
          'DOCUMENT_PARSER_CONFIGURED_MISSING',
        )
      }
      return provider
    }
    const registered = [...this.providers.values()]
    const [single] = registered
    if (single === undefined) {
      throw new DocumentParserError('no document parser provider is registered', 'DOCUMENT_PARSER_UNAVAILABLE')
    }
    if (registered.length > 1) {
      throw new DocumentParserError(
        `multiple document parser providers are registered (${registered.map(provider => provider.id).join(', ')}); configure one explicitly`,
        'DOCUMENT_PARSER_AMBIGUOUS',
      )
    }
    return single
  }
}

export default DocumentParserRuntime
