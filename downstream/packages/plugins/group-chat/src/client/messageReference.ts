/**
 * Room messages as `@` references in the composer.
 *
 * Registering a trigger source is the one supported way a plugin adds something to the `@`
 * menu, and the only way to get an official inline reference: the pipeline turns a pick into
 * an atomic chip, and the codec decides what that chip becomes for the model. Drawing a
 * separate quote bar would mean a second, unofficial representation of the same idea.
 *
 * A chip carries an id; the words are resolved through this module's cache because the codec
 * only ever receives `ref`. The cache is bounded to the messages listed most recently, which
 * is the same window the menu offers.
 *
 * @module @sparkelf/dsh-group-chat/client/messageReference
 */

import { listEvents } from './api.ts'
import type { RoomStore } from './store.ts'

/** Unique source name; duplicate `(trigger, name)` pairs throw at registration. */
const SOURCE_NAME = '@sparkelf/dsh-group-chat/message'

/** How many messages the menu offers at once. */
const MAX_CANDIDATES = 20

/** How much of a message the menu row and the chip label show. */
const LABEL_CHARS = 28

/** One resolved reference, kept for the codec and for the chip label. */
interface Resolved {
  readonly label: string
  readonly text: string
  readonly authorName?: string
}

/**
 * Reference id → what it points at.
 *
 * `ref` is `${roomId}:${messageId}` so it stays readable in storage and unique across rooms;
 * the words ride beside it because the codec is synchronous about identity and only receives
 * the id.
 */
const resolved = new Map<string, Resolved>()

/** The text of a message body, whether it arrived as blocks or as one plain string. */
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { readonly type?: unknown; readonly text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** One line, cut to `LABEL_CHARS` with an ellipsis. */
const shorten = (text: string): string =>
  text.length > LABEL_CHARS ? `${text.slice(0, LABEL_CHARS - 1)}…` : text

/** What one message row shows and what a pick would insert. */
const rowOf = (roomId: string, record: { readonly id: string; readonly event: { readonly data?: Record<string, unknown> } }): {
  readonly ref: string
  readonly name: string
  readonly description: string
  readonly resolved: Resolved
} | undefined => {
  const data = record.event.data
  if (data === undefined) return undefined
  const source = data['source'] as { messageId?: unknown; memberName?: unknown } | undefined
  const rowId = typeof source?.messageId === 'string' && source.messageId.length > 0
    ? source.messageId
    : typeof data['id'] === 'string' ? data['id'] : record.id
  const text = textOf(data['content'])
  if (text.length === 0) return undefined
  const authorName = typeof source?.memberName === 'string' && source.memberName.length > 0
    ? source.memberName
    : undefined
  const label = `${authorName ?? '消息'}：${shorten(text)}`
  return {
    ref: `${roomId}:${rowId}`,
    name: label,
    description: text.length > 60 ? `${text.slice(0, 59)}…` : text,
    resolved: { label, text, ...authorName === undefined ? {} : { authorName } },
  }
}

/** The slice of the trigger service this module registers into. */
export interface InputTriggersLike {
  registerSource(source: unknown): () => void
}

/**
 * Registers the room-message reference source.
 *
 * @param inputTriggers - the trigger pipeline service (`ctx.get('inputTriggers')`).
 * @param store - room store, read for the room the composer is writing into.
 * @returns the disposer.
 */
export const registerMessageSource = (inputTriggers: InputTriggersLike, store: RoomStore): (() => void) => {
  const source = {
    trigger: '@',
    name: SOURCE_NAME,
    // Display title only; `name` remains the identity every pick and mention is keyed by.
    label: '消息',
    order: 30,
    showGroupTitle: true,
    async candidates(_session: unknown, request: { readonly query: string; readonly signal: AbortSignal }) {
      const roomId = store.getState().activeRoomId
      if (roomId === undefined) return []
      const page = await listEvents(roomId)
      const needle = request.query.trim().toLowerCase()
      const out: { name: string; label: string; description: string; icon: string; value: string }[] = []
      // Newest first: a quote is nearly always of something just said.
      for (const record of [...page.events].reverse()) {
        if (request.signal.aborted) break
        const row = rowOf(roomId, record)
        if (row === undefined) continue
        if (needle.length > 0 && !row.resolved.text.toLowerCase().includes(needle)) continue
        resolved.set(row.ref, row.resolved)
        out.push({ name: row.name, label: row.name, description: row.description, icon: 'session', value: row.ref })
        if (out.length >= MAX_CANDIDATES) break
      }
      return out
    },
    onPick(pick: { readonly candidate: { readonly value?: string } }) {
      const ref = pick.candidate.value
      if (ref === undefined) return undefined
      const found = resolved.get(ref)
      if (found === undefined) return undefined
      return {
        insert: {
          source: SOURCE_NAME,
          ref,
          label: found.label,
          appearance: 'session',
          clipboardText: `@${found.label}`,
        },
      }
    },
    codec: {
      // What lands in the draft and the clipboard: the human-facing mention.
      clipboardText: (ref: string): string => {
        const found = resolved.get(ref)
        return found === undefined ? ref : `@${found.label}`
      },
      // What the model reads in place of the chip. A blockquote keeps the author on the first
      // line, which is what makes a quote readable after the session is compacted.
      serialize: (ref: string): Promise<string> => {
        const found = resolved.get(ref)
        if (found === undefined) return Promise.resolve(ref)
        const speaker = found.authorName === undefined ? '' : `${found.authorName}：`
        return Promise.resolve(`> ${speaker}${found.text}`)
      },
    },
  }
  return inputTriggers.registerSource(source)
}