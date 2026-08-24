/** Parsed-document projection wrapper around the transport-owned DeepSeek adapter. */

import {
  contentHasParsedDocument,
  LlmError,
  projectRequestDocumentsWithAttachments,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter as TransportDeepSeekAdapter } from './adapter-base.ts'
import type { DeepSeekAdapterOptions } from './adapter-base.ts'

export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  httpErrorCode,
} from './adapter-base.ts'
export type {
  DeepSeekAdapterOptions,
  DeepSeekCatalogModel,
  DeepSeekConnectionOptions,
} from './adapter-base.ts'

/**
 * Resolve durable parsed Markdown before the existing adapter performs its
 * provider-specific image/text serialization. This keeps large Markdown out of
 * session events while preserving the transport adapter's request semantics.
 */
export class DeepSeekAdapter extends TransportDeepSeekAdapter {
  constructor(private readonly projectionConfig: DeepSeekAdapterOptions) {
    super(projectionConfig)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const hasParsedDocuments = options.messages.some(message => contentHasParsedDocument(message.content))
    if (!hasParsedDocuments) {
      yield* super.stream(options)
      return
    }
    const attachments = this.projectionConfig.resolveAttachments?.()
    if (attachments === undefined) {
      throw new LlmError(
        'DeepSeek parsed-document conversion requires the durable attachment service.',
        'UNSUPPORTED_CONTENT',
      )
    }
    const messages = await projectRequestDocumentsWithAttachments(options.messages, attachments, options.signal)
    yield* super.stream({ ...options, messages })
  }
}
