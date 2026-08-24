/** Parsed-document projection wrapper around the pi-ai transport adapter. */

import {
  contentHasParsedDocument,
  LlmError,
  projectRequestDocumentsWithAttachments,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter as TransportPiAiAdapter } from './adapter-base.ts'
import type { PiAiAdapterOptions } from './adapter-base.ts'

export type { PiAiAdapterOptions } from './adapter-base.ts'

/** Resolve durable parsed Markdown before handing the request to pi-ai. */
export class PiAiAdapter extends TransportPiAiAdapter {
  constructor(private readonly projectionConfig: PiAiAdapterOptions) {
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
        'pi-ai parsed-document conversion requires the durable attachment service.',
        'UNSUPPORTED_CONTENT',
      )
    }
    const messages = await projectRequestDocumentsWithAttachments(options.messages, attachments, options.signal)
    yield* super.stream({ ...options, messages })
  }
}
