/** Optional external document-parser capability (`ctx.documentParser`). @module @deepseek-ai/dsh-document-parser */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { DocumentParseRequest, DocumentParseResult, DocumentParserProvider } from './types.ts'
import { DocumentParserError } from './types.ts'

export { DocumentParserError } from './types.ts'
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
  /** Explicit parser provider id; omission auto-selects exactly one usable provider. */
  provider?: string
  /** Maximum complete parsed Markdown bytes accepted for direct-context version one. */
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
  /** Maximum complete Markdown bytes Host admission may attach to one parsed document. */
  readonly maxDirectMarkdownBytes: number

  constructor(ctx: Context, config: Config) {
    super(ctx, 'documentParser')
    if (!Number.isSafeInteger(config.maxDirectMarkdownBytes) || config.maxDirectMarkdownBytes <= 0) {
      throw new Error('document-parser: maxDirectMarkdownBytes must be a positive safe integer')
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
    const dispose = this.ctx.effect(function* () {
      this.providers.set(provider.id, provider)
      yield () => this.providers.delete(provider.id)
    }.bind(this), 'documentParser.registerProvider()')
    return () => void dispose()
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
      if (!provider.available()) {
        throw new DocumentParserError(
          `configured document parser provider "${this.providerId}" is unavailable`,
          'DOCUMENT_PARSER_CONFIGURED_UNAVAILABLE',
        )
      }
      return provider
    }
    const usable = [...this.providers.values()].filter(provider => provider.available())
    const [single] = usable
    if (single === undefined) {
      throw new DocumentParserError('no usable document parser provider is registered', 'DOCUMENT_PARSER_UNAVAILABLE')
    }
    if (usable.length > 1) {
      throw new DocumentParserError(
        `multiple usable document parser providers are registered (${usable.map(provider => provider.id).join(', ')}); configure one explicitly`,
        'DOCUMENT_PARSER_AMBIGUOUS',
      )
    }
    return single
  }
}

export default DocumentParserRuntime
