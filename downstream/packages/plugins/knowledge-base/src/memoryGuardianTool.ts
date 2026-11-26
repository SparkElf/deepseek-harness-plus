/**
 * Model-facing `memory_guardian_send` tool.
 *
 * Any authenticated caller may notify their own guardian — the tool is a
 * read-group surface (`kb:file:read`) because it never writes knowledge or
 * another user's state. It is deliberately NOT a target-session API: the tool
 * accepts only a reason, the optional source session/compaction context and a
 * note, then resolves the caller's own guardian through guardian.json. There is
 * no `userId` argument and no arbitrary `target` argument, so a model cannot
 * address another person's guardian.
 *
 * Delivery uses {@link sendToGuardian}, the same path the idle/compaction
 * triggers use. A busy guardian queues the message in DSH's own inbox; this
 * tool adds no queue of its own and returns `queued: true` so the caller knows
 * the guardian will process it after the current turn.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-guardian-tool
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { asKnowledgeToolError, KnowledgeToolError } from './knowledgeTools.ts'
import {
  sendToGuardian,
  type GuardianReason,
  type GuardianSessionHost,
} from './guardianSession.ts'

/** The Host seam the tool needs. */
export interface MemoryGuardianToolHost {
  /** The authenticated caller. Only `userId` is used to find the guardian. */
  resolveCaller(): Promise<{ userId: string }>
  /** The guardian session seam shared with the triggers. */
  guardian: GuardianSessionHost
  /** Whether learning is enabled for this user; paused rejects notify/remember. */
  isEnabled?(userId: string): Promise<boolean> | boolean
}

/** Arguments accepted by `memory_guardian_send`. */
export interface MemoryGuardianSendArgs {
  reason?: string
  sessionId?: string
  note?: string
}

/** Result returned to the model. */
export interface MemoryGuardianSendValue {
  ok: true
  reason: GuardianReason
  delivered: boolean
  queued: boolean
  /** The caller's guardian session that received the message. */
  sessionId: string
  /** True when this call lazily created or recreated the guardian. */
  created: boolean
  rendered: string
}

const REASONS: readonly GuardianReason[] = ['idle', 'compaction', 'dream', 'manual']
const MAX_SESSION_ID_CHARS = 200
const MAX_NOTE_CHARS = 2000

const textOutput = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => {
    const record = value as { rendered?: unknown } | null
    const text = record !== null && typeof record?.rendered === 'string'
      ? record.rendered
      : JSON.stringify(value, null, 2)
    return [{ type: 'text' as const, text }]
  },
}

const run = async (operation: () => Promise<Record<string, any>>): Promise<Record<string, any>> => {
  try {
    return await operation()
  } catch (error) {
    throw asKnowledgeToolError(error)
  }
}

function requireReason(value: unknown): GuardianReason {
  if (typeof value !== 'string' || !REASONS.includes(value as GuardianReason)) {
    throw new KnowledgeToolError('invalid', `reason must be one of ${REASONS.join(', ')}`)
  }
  return value as GuardianReason
}

function optionalSessionId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new KnowledgeToolError('invalid', 'sessionId must be a string')
  const sessionId = value.trim()
  if (sessionId === '') return undefined
  if (sessionId.length > MAX_SESSION_ID_CHARS || /[\u0000-\u001f\u007f]/.test(sessionId)) {
    throw new KnowledgeToolError('invalid', 'sessionId is not a valid session id')
  }
  return sessionId
}

function optionalNote(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new KnowledgeToolError('invalid', 'note must be a string')
  const note = value.trim()
  if (note === '') return undefined
  if (note.length > MAX_NOTE_CHARS) {
    throw new KnowledgeToolError('invalid', `note must be at most ${MAX_NOTE_CHARS} characters`)
  }
  return note
}

/**
 * Build the `memory_guardian_send` tool.
 *
 * @param host - caller resolver and the guardian session seam.
 * @returns Tool definitions for the disclosure coordinator.
 */
export function createMemoryGuardianTools(host: MemoryGuardianToolHost): ToolDefinition[] {
  return [
    defineTool({
      name: 'memory_guardian_send',
      description: 'Send one message to the caller\'s own memory guardian session. Use it to ask the guardian to '
        + 'process an idle session, a compaction, the daily dream, or an explicit manual request. The guardian is '
        + 'resolved lazily from the caller\'s guardian.json and reused; a busy guardian queues this message behind its '
        + 'current turn and the result says queued:true. It never targets another user and never creates a queue of '
        + 'its own. `sessionId` is the source session being reported, not the guardian target.',
      parameters: {
        reason: { type: 'string', required: true, description: 'idle | compaction | dream | manual.' },
        sessionId: { type: 'string', description: 'Source session id the guardian should inspect, when applicable.' },
        note: { type: 'string', description: 'Short context for the guardian; never a document body.' },
      },
      output: textOutput,
      execute: async (args: MemoryGuardianSendArgs) => run(async () => {
        const reason = requireReason(args.reason)
        const sourceSessionId = optionalSessionId(args.sessionId)
        const note = optionalNote(args.note)

        const caller = await host.resolveCaller()
        const userId = typeof caller.userId === 'string' ? caller.userId.trim() : ''
        if (userId === '') {
          throw new KnowledgeToolError('unauthorized', 'memory_guardian_send requires an authenticated caller')
        }
        if (host.isEnabled !== undefined && !await host.isEnabled(userId)) {
          throw new KnowledgeToolError(
            'forbidden',
            'memory is paused; open Knowledge Base → Memory and confirm enable before asking the guardian to remember',
          )
        }

        const result = await sendToGuardian(host.guardian, userId, {
          reason,
          ...(sourceSessionId === undefined ? {} : { sessionId: sourceSessionId }),
          ...(note === undefined ? {} : { note }),
        })

        const value = {
          ok: true as const,
          reason,
          delivered: result.delivered,
          queued: result.queued,
          sessionId: result.sessionId,
          created: result.created,
        }
        return { ...value, rendered: JSON.stringify(value, null, 2) }
      }),
    }),
  ]
}
