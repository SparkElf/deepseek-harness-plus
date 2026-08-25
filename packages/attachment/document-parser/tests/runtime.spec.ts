import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import DocumentParserRuntime, {
  type DocumentParseRequest,
  type DocumentParseResult,
  type DocumentParserProvider,
} from '@deepseek-ai/dsh-document-parser'

const request: DocumentParseRequest = {
  attachment: {
    attachmentId: AttachmentId(`sha256:${'0'.repeat(64)}`),
    mediaType: 'application/pdf',
    bytes: 4,
    name: 'sample.pdf',
  },
  data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
}

const result: DocumentParseResult = {
  markdown: new TextEncoder().encode('# parsed'),
  contentList: new TextEncoder().encode('[]'),
  images: [],
}

function provider(
  id: string,
  parse: DocumentParserProvider['parse'] = () => Promise.resolve(result),
): DocumentParserProvider {
  return { id, parse }
}

async function mountParser(providerId?: string): Promise<{ ctx: Context; parser: DocumentParserRuntime }> {
  const ctx = new Context()
  await ctx.plugin(DocumentParserRuntime, {
    ...(providerId === undefined ? {} : { provider: providerId }),
    maxDirectMarkdownBytes: 1024,
  })
  return { ctx, parser: ctx.documentParser }
}

describe('DocumentParserRuntime provider registration', () => {
  it('registers and disposes one provider', async () => {
    const { parser } = await mountParser()
    const dispose = parser.registerProvider(provider('mineru'))
    await expect(parser.parse(request)).resolves.toMatchObject({ parser: 'mineru' })

    dispose()
    await expect(parser.parse(request)).rejects.toThrow(expect.objectContaining({
      code: 'DOCUMENT_PARSER_UNAVAILABLE',
    }))
  })

  it('rejects duplicate provider ids', async () => {
    const { parser } = await mountParser()
    parser.registerProvider(provider('mineru'))
    expect(() => parser.registerProvider(provider('mineru'))).toThrow(expect.objectContaining({
      code: 'DOCUMENT_PARSER_DUPLICATE_PROVIDER',
    }))
  })

  it('removes provider registrations when the contributing fiber is disposed', async () => {
    const { ctx, parser } = await mountParser()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.documentParser.registerProvider(provider('mineru'))
    }, { inject: ['documentParser'] }))

    await expect(parser.parse(request)).resolves.toMatchObject({ parser: 'mineru' })
    await fiber.dispose()
    await expect(parser.parse(request)).rejects.toThrow(expect.objectContaining({
      code: 'DOCUMENT_PARSER_UNAVAILABLE',
    }))
  })
})

describe('DocumentParserRuntime provider selection', () => {
  it('fails rather than selecting by registration order when multiple providers are registered', async () => {
    const { parser } = await mountParser()
    parser.registerProvider(provider('mineru'))
    parser.registerProvider(provider('other'))
    await expect(parser.parse(request)).rejects.toThrow(expect.objectContaining({
      code: 'DOCUMENT_PARSER_AMBIGUOUS',
    }))
  })

  it('fails when the configured provider is missing', async () => {
    const { parser } = await mountParser('mineru')
    parser.registerProvider(provider('other'))
    await expect(parser.parse(request)).rejects.toThrow(expect.objectContaining({
      code: 'DOCUMENT_PARSER_CONFIGURED_MISSING',
    }))
  })

  it('uses the configured provider when another provider is also registered', async () => {
    const { parser } = await mountParser('mineru')
    parser.registerProvider(provider('other', () => Promise.reject(new Error('wrong provider'))))
    parser.registerProvider(provider('mineru'))
    await expect(parser.parse(request)).resolves.toEqual({ parser: 'mineru', result })
  })

  it('forwards the request and AbortSignal to the selected provider', async () => {
    const { parser } = await mountParser()
    const seen: Array<{ request: DocumentParseRequest; signal?: AbortSignal }> = []
    parser.registerProvider(provider('mineru', (input, signal) => {
      seen.push({ request: input, ...(signal === undefined ? {} : { signal }) })
      return Promise.resolve(result)
    }))
    const controller = new AbortController()

    await parser.parse(request, controller.signal)
    expect(seen).toEqual([{ request, signal: controller.signal }])
  })
})
