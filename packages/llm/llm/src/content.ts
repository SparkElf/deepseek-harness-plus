/** Content-block structure helpers. @module @deepseek-ai/dsh-llm/content */

import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, DocumentBlock } from './types.ts'
import type { Message } from './message.ts'

/** Model-facing stand-in for an image removed to fit a provider request bound. */
export const OFFLOADED_IMAGE_TEXT
  = '[image omitted to keep the request within its image limit; older images are omitted first. If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]'

/**
 * Truthful generic-model projection for an accepted document before a parser
 * has produced model-readable content. Generic document intake must never make
 * a provider silently behave as if the file was read.
 * @param block - durable original-document block.
 * @returns explicit provider-neutral text marker.
 */
export function unparsedDocumentText(block: DocumentBlock): string {
  const { name, mediaType } = block.attachment
  return `[attached document: ${name} (${mediaType}); the document is stored, but its contents have not been parsed and are not available to the model yet.]`
}

/**
 * Replace durable document blocks with explicit unparsed markers for a model
 * request without mutating session history. Nested tool-result content is
 * projected recursively; every other merge-extensible block is preserved.
 * @param blocks - durable content blocks.
 * @returns original array when no document occurs, otherwise a projected copy.
 */
export function projectUnparsedDocuments(blocks: readonly ContentBlock[]): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'document') {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: unparsedDocumentText(block) })
      continue
    }
    if (block.type === 'tool-result') {
      const content = projectUnparsedDocuments(block.content)
      if (content !== block.content) {
        next ??= blocks.slice(0, index)
        next.push({ ...block, content })
        continue
      }
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/**
 * Project documents in every provider request message without changing durable messages.
 * This synchronous path is retained for generic unparsed documents and adapters
 * that do not need a durable parser artifact read.
 * @param messages - durable provider-neutral messages in request order.
 * @returns the original list when no document occurs, otherwise shallow message copies with document markers.
 */
export function projectRequestDocuments(messages: readonly Message[]): readonly Message[] {
  let changed = false
  const projected = messages.map((message) => {
    const content = projectUnparsedDocuments(message.content)
    if (content === message.content) return message
    changed = true
    return { ...message, content }
  })
  return changed ? projected : messages
}

/** True when content contains a document whose complete Markdown is stored durably. */
export function contentHasParsedDocument(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'document'
    ? block.attachment.parsed !== undefined
    : block.type === 'tool-result' && contentHasParsedDocument(block.content))
}

/** Decode one accepted parser Markdown artifact without replacement characters. */
async function parsedDocumentText(
  block: DocumentBlock,
  attachments: AttachmentStore,
  signal?: AbortSignal,
): Promise<string> {
  const parsed = block.attachment.parsed
  if (parsed === undefined) return unparsedDocumentText(block)
  const stored = await attachments.readFile(parsed.markdown, signal)
  let markdown: string
  try {
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(stored.data)
  } catch (error: unknown) {
    throw new Error(`Parsed Markdown for document "${block.attachment.name}" is not valid UTF-8.`, { cause: error })
  }
  return `[attached document: ${block.attachment.name} (${block.attachment.mediaType}); parsed contents follow]\n\n${markdown}\n\n[end attached document: ${block.attachment.name}]`
}

/** Resolve parsed document references to complete Markdown while preserving unparsed truth markers. */
async function projectDocumentsWithAttachments(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore,
  signal?: AbortSignal,
): Promise<ContentBlock[]> {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'document') {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: await parsedDocumentText(block, attachments, signal) })
      continue
    }
    if (block.type === 'tool-result') {
      const content = await projectDocumentsWithAttachments(block.content, attachments, signal)
      if (content !== block.content) {
        next ??= blocks.slice(0, index)
        next.push({ ...block, content })
        continue
      }
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/**
 * Resolve every durable parsed-document Markdown reference for one provider request.
 * Session history remains ref-only; the complete Markdown exists transiently only
 * while this provider request is assembled. A fresh mutable message array is
 * returned because provider GenerateOptions owns a mutable request snapshot.
 */
export async function projectRequestDocumentsWithAttachments(
  messages: readonly Message[],
  attachments: AttachmentStore,
  signal?: AbortSignal,
): Promise<Message[]> {
  const projected: Message[] = []
  for (const message of messages) {
    const content = await projectDocumentsWithAttachments(message.content, attachments, signal)
    projected.push(content === message.content ? message : { ...message, content })
  }
  return projected
}

/**
 * True when typed model content contains an image block, walking nested
 * tool-result content. This is the one recursive image walk shared by every
 * image policy (capability gating, text-only serialization, compaction
 * survey), so a consumer cannot silently diverge on nesting depth.
 * @param content - typed model content blocks.
 * @returns whether any nested block is an image.
 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image'
    || (block.type === 'tool-result' && contentHasImage(block.content)))
}

/** Base64 length of raw image bytes, including padding. */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/** Collect base64 payload lengths in request and nested-block order. */
function collectImageLengths(blocks: readonly ContentBlock[], lengths: number[]): void {
  for (const block of blocks) {
    if (block.type === 'image') {
      lengths.push(base64Length(block.attachment.bytes))
    } else if (block.type === 'tool-result') {
      collectImageLengths(block.content, lengths)
    }
  }
}

/** Replace the first `remaining.count` image occurrences without mutating durable messages. */
function replaceOldestImages(
  blocks: readonly ContentBlock[],
  remaining: { count: number },
): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image' && remaining.count > 0) {
      remaining.count -= 1
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: OFFLOADED_IMAGE_TEXT })
      continue
    }
    if (block.type === 'tool-result') {
      const content = replaceOldestImages(block.content, remaining)
      if (content !== block.content) {
        next ??= blocks.slice(0, index)
        next.push({ ...block, content })
        continue
      }
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/**
 * Return transient request messages whose oldest images are replaced until
 * their accumulated base64 payload fits the configured bound. The selection
 * is deterministic from durable message order and attachment metadata; a
 * provider can serialize the returned messages without reading omitted bytes.
 * @param messages - complete request history, oldest first.
 * @param maxRequestImageBytes - positive bound on total base64 image payload; undefined preserves every image.
 * @returns the original messages when they already fit, otherwise shallow message copies with replaced content trees.
 */
export function offloadRequestImages(
  messages: readonly Message[],
  maxRequestImageBytes: number | undefined,
): readonly Message[] {
  if (maxRequestImageBytes === undefined) return messages
  const lengths: number[] = []
  for (const message of messages) collectImageLengths(message.content, lengths)
  let total = lengths.reduce((sum, bytes) => sum + bytes, 0)
  let count = 0
  for (const bytes of lengths) {
    if (total <= maxRequestImageBytes) break
    total -= bytes
    count += 1
  }
  if (count === 0) return messages
  const remaining = { count }
  return messages.map((message) => {
    const content = replaceOldestImages(message.content, remaining)
    return content === message.content ? message : { ...message, content }
  })
}
