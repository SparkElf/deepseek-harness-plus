/** Content-block structure helpers. @module @deepseek-ai/dsh-llm/content */

import type { AttachmentStore, DocumentAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, DocumentBlock } from './types.ts'
import type { Message } from './message.ts'

/** Model-facing stand-in for an image removed to fit a provider request bound. */
export const OFFLOADED_IMAGE_TEXT
  = '[image omitted to keep the request within its image limit; older images are omitted first. If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]'

/**
 * True when content contains a durable parsed document, including nested tool results.
 * @param content - typed model content blocks.
 * @returns whether any nested block is a document.
 */
export function contentHasDocument(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'document'
    || (block.type === 'tool-result' && contentHasDocument(block.content)))
}

/**
 * Render the complete request-only text representation of one parsed document.
 * @param attachment - durable original metadata displayed in delimiters.
 * @param markdown - complete validated UTF-8 parser output bytes.
 * @returns clearly delimited model-visible text used by every adapter.
 */
export function renderParsedDocumentText(attachment: DocumentAttachmentRef, markdown: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(markdown)
  return `[attached document: ${attachment.name} (${attachment.mediaType}); parsed contents follow]\n\n${text}\n\n[end attached document: ${attachment.name}]`
}

/** Resolve one required parsed Markdown object into the shared request-only representation. */
async function parsedDocumentText(
  block: DocumentBlock,
  attachments: AttachmentStore,
  signal?: AbortSignal,
): Promise<string> {
  // Admission persisted complete UTF-8 Markdown; request projection reads only that durable reference.
  const stored = await attachments.readFile(block.parsed.markdown, signal)
  return renderParsedDocumentText(block.attachment, stored.data)
}

/** Resolve parsed document references recursively without mutating durable session content. */
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
 * Session history remains ref-only; complete Markdown exists transiently only while
 * this provider request is assembled. Version one retains extracted images as
 * durable parsed artifacts but does not inject them into ordinary requests.
 * @param messages - durable ref-only request history.
 * @param attachments - store used to resolve each complete Markdown object.
 * @param signal - optional cancellation for durable object reads.
 * @returns request-only messages with every document replaced by complete delimited Markdown.
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
