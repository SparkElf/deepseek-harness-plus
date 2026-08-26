/** Host admission bridge from durable originals to required external document parsing. */

import type { Context } from '@deepseek-ai/cordis'
import {
  type DocumentAttachmentRef,
  type ImageAttachmentRef,
  type ParsedDocumentRef,
} from '@deepseek-ai/dsh-attachment'
import { DocumentParserError } from '@deepseek-ai/dsh-document-parser'
import { renderParsedDocumentText } from '@deepseek-ai/dsh-llm'

/** Durable artifact media types owned by the generic attachment store. */
const MARKDOWN_MEDIA_TYPE = 'text/markdown'
const CONTENT_LIST_MEDIA_TYPE = 'application/json'

/** One original and its required immutable parse bundle before mixed prompt order is rebuilt. */
export interface ParsedDocument {
  attachment: DocumentAttachmentRef
  parsed: ParsedDocumentRef
}

/**
 * Parse every admitted original, persist the complete parser bundle, and prove
 * the submitted batch fits the aggregate complete direct-document text budget.
 * @param ctx - Host context owning attachment storage and the required parser runtime.
 * @param refs - already-persisted original document references in prompt order.
 * @returns originals paired with complete immutable parser output references.
 */
export async function parseDocumentRefs(
  ctx: Context,
  refs: readonly DocumentAttachmentRef[],
): Promise<readonly ParsedDocument[]> {
  if (refs.length === 0) return []
  const parser = ctx.get('documentParser')
  if (parser === undefined) {
    throw new DocumentParserError(
      'Document parsing is not configured for this Harness.',
      'DOCUMENT_PARSER_UNAVAILABLE',
    )
  }

  const parsedDocuments: ParsedDocument[] = []
  let directDocumentBytes = 0
  for (const ref of refs) {
    // 原件与解析结果全部持久化、完整模型文档文本合计预算通过后，调用方才能追加user event。
    const original = await ctx.attachments.readFile(ref)
    const parsed = await parser.parse({ attachment: ref, data: original.data })
    const markdown = await ctx.attachments.saveFile({
      data: parsed.result.markdown,
      mediaType: MARKDOWN_MEDIA_TYPE,
      name: `${ref.name}.md`,
    })
    const contentList = await ctx.attachments.saveFile({
      data: parsed.result.contentList,
      mediaType: CONTENT_LIST_MEDIA_TYPE,
      name: `${ref.name}_content_list.json`,
    })
    const images: ImageAttachmentRef[] = []
    for (const image of parsed.result.images) {
      images.push(await ctx.attachments.saveImage(image))
    }

    directDocumentBytes += new TextEncoder().encode(renderParsedDocumentText(ref, parsed.result.markdown)).byteLength
    if (directDocumentBytes > parser.maxDirectMarkdownBytes) {
      throw new DocumentParserError(
        'Parsed documents exceed the configured complete direct-context byte limit for one submitted message.',
        'DOCUMENT_PARSE_CONTEXT_TOO_LARGE',
      )
    }
    parsedDocuments.push({
      attachment: ref,
      parsed: {
        parser: parsed.parser,
        markdown,
        contentList,
        images,
      },
    })
  }
  return parsedDocuments
}
