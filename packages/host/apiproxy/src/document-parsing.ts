/** Host admission bridge from durable originals to optional external document parsing. */

import type { Context } from '@deepseek-ai/cordis'
import {
  AttachmentError,
  type DocumentAttachmentRef,
  type ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import { DocumentParserError } from '@deepseek-ai/dsh-document-parser'

/** Durable artifact media types owned by the generic attachment store. */
const MARKDOWN_MEDIA_TYPE = 'text/markdown'
const CONTENT_LIST_MEDIA_TYPE = 'application/json'

/**
 * Parse every admitted original when a parser runtime is composed, persist the
 * complete parser bundle, prove the submitted batch's aggregate direct-context
 * Markdown bound, and return immutable document refs carrying only durable
 * artifact references.
 *
 * No parser runtime preserves the generic #82 behavior: originals remain
 * durable and project to the explicit unparsed marker. Parsed output objects
 * published before a later failure remain unreachable and can be collected by
 * attachment retention policy; no user event is appended by the caller.
 */
export async function parseDocumentRefs(
  ctx: Context,
  refs: readonly DocumentAttachmentRef[],
): Promise<readonly DocumentAttachmentRef[]> {
  const parser = ctx.get('documentParser')
  if (parser === undefined || refs.length === 0) return refs

  const parsedRefs: DocumentAttachmentRef[] = []
  let directMarkdownBytes = 0
  for (const ref of refs) {
    try {
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

      directMarkdownBytes += markdown.bytes
      if (directMarkdownBytes > parser.maxDirectMarkdownBytes) {
        throw new DocumentParserError(
          'Parsed documents exceed the configured direct-context Markdown byte limit for one submitted message.',
          'DOCUMENT_PARSE_CONTEXT_TOO_LARGE',
        )
      }
      parsedRefs.push({
        ...ref,
        parsed: {
          parser: parsed.parser,
          markdown,
          contentList,
          images,
        },
      })
    } catch (error: unknown) {
      if (error instanceof DocumentParserError) {
        throw new AttachmentError(error.message, error.code, { cause: error })
      }
      throw error
    }
  }
  return parsedRefs
}
