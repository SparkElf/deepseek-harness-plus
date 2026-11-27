/**
 * Guardian-only tools that write the five memory types and promote a SOP.
 *
 * The guardian session is the single writer of personal memory. Ordinary
 * sessions may read memory through `memory_context` and notify the guardian
 * through `memory_guardian_send`, but they must not call these tools; the
 * execute bodies check the live session against the guardian state before
 * touching a file.
 *
 * The tools stay close to the product vocabulary: the model supplies a type and
 * the type's fields, and the store applies merging, privacy and validation.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-record-tool
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { asKnowledgeToolError, KnowledgeToolError } from './knowledgeTools.ts'
import {
  MemoryStore,
  MEMORY_SOP_DIR,
  type MemoryIndex,
} from './memoryStore.ts'
import type { MemoryGraphWriter } from './memoryGraphWriter.ts'
import type { MemoryEntryInput, MemoryOrigin, Privacy, Sop, SopStatus } from './memoryTypes.ts'
import { promoteSopToSkill, deleteSopAfterPromotion } from './memorySkillPromotion.ts'
import { join } from 'node:path'

/** The Host seam for the guardian write tools. */
export interface MemoryRecordToolHost {
  /** Authenticated caller plus the live session that is calling the tool. */
  resolveCaller(): Promise<{ userId: string; sessionId?: string }>
  /** Whether this session is the user's guardian session (state-file lookup). */
  isGuardianSession(sessionId: string | undefined): Promise<boolean>
  /** The store for one user's personal memory. */
  storeFor(userId: string): Promise<MemoryStore>
  /** The graph writer for the same user's personal-memory graph. */
  graphWriterFor(userId: string): MemoryGraphWriter
  /** Root that holds one directory per DSH skill. */
  skillsRootFor(userId: string): Promise<string>
  /** Whether personal memory is enabled; paused refuses writes. */
  isEnabled?(userId: string): Promise<boolean> | boolean
}

const jsonOutput = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: JSON.stringify(value, null, 2),
  }],
}

/** Tool results are JSON objects; the optional-field union is widened here. */
const asJson = <T>(value: T): Record<string, never> => value as unknown as Record<string, never>

/** One human-readable SOP body from its structured fields. */
function sopBody(sop: Sop): string {
  // The structured fields are the canonical skill body. `body` is an optional
  // appendix, never a replacement: a short human note used to erase the
  // trigger/steps/tools/success criteria from the promoted skill.
  const lines = [
    `# ${sop.title}`,
    '',
    `触发条件：${sop.trigger}`,
    '',
    '步骤：',
    ...sop.steps.map((step, index) => `${String(index + 1)}. ${step}`),
  ]
  if ((sop.tools ?? []).length > 0) lines.push('', '工具：', ...(sop.tools ?? []).map(tool => `- ${tool}`))
  if ((sop.successCriteria ?? []).length > 0) {
    lines.push('', '成功标准：', ...(sop.successCriteria ?? []).map(item => `- ${item}`))
  }
  if (typeof sop.body === 'string' && sop.body.trim() !== '') {
    lines.push('', '补充说明：', sop.body.trim())
  }
  return lines.join('\n')
}

/** Require the live session to be the caller's guardian session. */
async function requireGuardian(
  host: MemoryRecordToolHost,
  sessionId?: string,
): Promise<{ userId: string; sessionId?: string }> {
  const caller = await host.resolveCaller()
  if (host.isEnabled !== undefined && !await host.isEnabled(caller.userId)) {
    throw new KnowledgeToolError('forbidden', 'memory is paused; enable it in Knowledge Base → Memory before writing')
  }
  if (!await host.isGuardianSession(sessionId)) {
    throw new KnowledgeToolError(
      'forbidden',
      'memory writes are reserved for the memory guardian session; use memory_guardian_send from a normal session',
    )
  }
  return { ...caller, ...(sessionId === undefined ? {} : { sessionId }) }
}

/** Build one store input from the flat tool arguments. */
function inputFromArgs(args: Record<string, unknown>): MemoryEntryInput {
  const type = String(args.type ?? '')
  const common = {
    ...(typeof args.privacy === 'string' ? { privacy: args.privacy as Privacy } : {}),
    ...(typeof args.app === 'string' ? { app: args.app } : {}),
    ...(typeof args.scenario === 'string' ? { scenario: args.scenario } : {}),
    ...(typeof args.taskType === 'string' ? { taskType: args.taskType } : {}),
    ...(Array.isArray(args.entities) ? { entities: args.entities as string[] } : {}),
    ...(typeof args.sourceSession === 'string' ? { sourceSession: args.sourceSession } : {}),
    ...(typeof args.sourceTime === 'string' ? { sourceTime: args.sourceTime } : {}),
    ...(typeof args.displayTitle === 'string' ? { displayTitle: args.displayTitle } : {}),
    ...(typeof args.sourceLabel === 'string' ? { sourceLabel: args.sourceLabel } : {}),
    ...(Array.isArray(args.sourceSeqs) ? { sourceSeqs: args.sourceSeqs as number[] } : {}),
    ...(typeof args.origin === 'string' ? { origin: args.origin as MemoryOrigin } : {}),
    ...(Array.isArray(args.tags) ? { tags: args.tags as string[] } : {}),
    ...(Array.isArray(args.evidence) ? { evidence: args.evidence as string[] } : {}),
    ...(typeof args.credentialRef === 'string' ? { credentialRef: args.credentialRef } : {}),
    ...(typeof args.supersedes === 'string' ? { supersedes: args.supersedes } : {}),
    ...(typeof args.body === 'string' ? { body: args.body } : {}),
  }
  if (type === 'preference') {
    return { ...common, type, topic: String(args.topic ?? ''), value: String(args.value ?? '') }
  }
  if (type === 'pitfall') {
    return {
      ...common,
      type,
      errorSignature: String(args.errorSignature ?? ''),
      context: String(args.context ?? ''),
      solution: String(args.solution ?? ''),
      ...(Array.isArray(args.appliesTo) ? { appliesTo: args.appliesTo as string[] } : {}),
    }
  }
  if (type === 'episodic') {
    return {
      ...common,
      type,
      summary: String(args.summary ?? ''),
      ...(typeof args.request === 'string' ? { request: args.request } : {}),
      ...(typeof args.outcome === 'string' ? { outcome: args.outcome } : {}),
      ...(Array.isArray(args.sopUsed) ? { sopUsed: args.sopUsed as string[] } : {}),
    }
  }
  if (type === 'fact') {
    return {
      ...common,
      type,
      factKind: String(args.factKind ?? 'clarification') as never,
      key: String(args.key ?? ''),
      statement: String(args.statement ?? ''),
      ...(typeof args.scope === 'string' ? { scope: args.scope } : {}),
    }
  }
  if (type === 'sop') {
    return {
      ...common,
      type,
      ...(typeof args.slug === 'string' ? { slug: args.slug } : {}),
      title: String(args.title ?? ''),
      ...(typeof args.status === 'string' ? { status: args.status as SopStatus } : {}),
      trigger: String(args.trigger ?? ''),
      steps: Array.isArray(args.steps) ? args.steps as string[] : [],
      ...(Array.isArray(args.tools) ? { tools: args.tools as string[] } : {}),
      ...(Array.isArray(args.successCriteria) ? { successCriteria: args.successCriteria as string[] } : {}),
    }
  }
  throw new KnowledgeToolError('invalid', 'type must be preference, pitfall, episodic, fact or sop')
}

/** Build the two guardian write tools. */
export function createMemoryRecordTools(host: MemoryRecordToolHost): ToolDefinition[] {
  return [
    defineTool({
      name: 'memory_record',
      description: 'Write one personal-memory entry. Reserved for the memory guardian session. '
        + 'type is preference, pitfall, episodic, fact or sop. The store merges by topic/error signature/fact key, '
        + 'enforces privacy (secret requires credentialRef, never a plaintext secret), and updates the personal memory graph.',
      parameters: {
        type: { type: 'string', required: true, description: 'preference | pitfall | episodic | fact | sop' },
        action: { type: 'string', description: 'For sop: create (default), update or delete.' },
        topic: { type: 'string', description: 'Preference topic (merge key).' },
        value: { type: 'string', description: 'Preference value.' },
        errorSignature: { type: 'string', description: 'Pitfall dedupe key.' },
        context: { type: 'string', description: 'Pitfall context.' },
        solution: { type: 'string', description: 'Pitfall solution.' },
        appliesTo: { type: 'array', items: { type: 'string' }, description: 'Pitfall applicability.' },
        summary: { type: 'string', description: 'Episodic summary.' },
        request: { type: 'string', description: 'Episodic request.' },
        outcome: { type: 'string', description: 'Episodic outcome.' },
        sopUsed: { type: 'array', items: { type: 'string' }, description: 'Episodic SOP ids used.' },
        factKind: { type: 'string', description: 'requirement | decision | clarification' },
        key: { type: 'string', description: 'Fact merge key.' },
        statement: { type: 'string', description: 'Fact statement.' },
        scope: { type: 'string', description: 'Fact scope (personal/project/app).' },
        slug: { type: 'string', description: 'SOP slug (kebab-case; required for update/delete).' },
        title: { type: 'string', description: 'SOP title.' },
        trigger: { type: 'string', description: 'SOP trigger condition.' },
        steps: { type: 'array', items: { type: 'string' }, description: 'SOP steps.' },
        tools: { type: 'array', items: { type: 'string' }, description: 'SOP tools/parameters.' },
        successCriteria: { type: 'array', items: { type: 'string' }, description: 'SOP success criteria.' },
        status: { type: 'string', description: 'SOP status: draft | testing | promoted | dropped' },
        privacy: { type: 'string', description: 'normal | private | sensitive | secret (secret requires credentialRef)' },
        app: { type: 'string', description: 'Application id (free string).' },
        scenario: { type: 'string', description: 'Scenario text.' },
        taskType: { type: 'string', description: 'Task type.' },
        entities: { type: 'array', items: { type: 'string' }, description: 'Entities/links.' },
        sourceSession: { type: 'string', description: 'Source session id (internal locator; never shown in lists).' },
        sourceTime: { type: 'string', description: 'When the remembered thing happened.' },
        displayTitle: { type: 'string', description: 'Short user-facing title (<= 20 chars); no tool names, paths or session ids.' },
        sourceLabel: { type: 'string', description: 'Human-readable source snapshot, e.g. a session title or scenario.' },
        sourceSeqs: { type: 'array', items: { type: 'number' }, description: 'Evidence event seqs inside the source session.' },
        origin: { type: 'string', description: 'auto (extracted) or explicit (user asked to remember).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags.' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'Evidence pointers/quotes.' },
        credentialRef: { type: 'string', description: 'Credential reference for privacy=secret.' },
        supersedes: { type: 'string', description: 'Entry id this replaces.' },
        body: { type: 'string', description: 'Optional free body.' },
      },
      output: jsonOutput,
      execute: async (args: Record<string, unknown>, exec: { agent?: { id?: string } }) => {
        try {
          const caller = await requireGuardian(host, exec.agent?.id)
          const store = await host.storeFor(caller.userId)
          const writer = await host.graphWriterFor(caller.userId)
          const type = String(args.type ?? '')
          if (type === 'sop' && args.action === 'delete') {
            const slug = String(args.slug ?? '')
            const deleted = await store.deleteSop(slug)
            if (deleted) await writer.syncAll()
            return asJson({ ok: true, type, action: 'delete', slug, deleted })
          }
          if (type === 'sop' && args.action === 'update') {
            const slug = String(args.slug ?? '')
            const patch = {
              ...(typeof args.title === 'string' ? { title: args.title } : {}),
              ...(typeof args.trigger === 'string' ? { trigger: args.trigger } : {}),
              ...(Array.isArray(args.steps) ? { steps: args.steps as string[] } : {}),
              ...(Array.isArray(args.tools) ? { tools: args.tools as string[] } : {}),
              ...(Array.isArray(args.successCriteria) ? { successCriteria: args.successCriteria as string[] } : {}),
              ...(typeof args.status === 'string' ? { status: args.status as SopStatus } : {}),
              ...(typeof args.privacy === 'string' ? { privacy: args.privacy as Privacy } : {}),
              ...(typeof args.app === 'string' ? { app: args.app } : {}),
              ...(typeof args.scenario === 'string' ? { scenario: args.scenario } : {}),
              ...(typeof args.sourceLabel === 'string' ? { sourceLabel: args.sourceLabel } : {}),
              ...(Array.isArray(args.sourceSeqs) ? { sourceSeqs: args.sourceSeqs as number[] } : {}),
              ...(typeof args.origin === 'string' ? { origin: args.origin as MemoryOrigin } : {}),
            }
            const updated = await store.updateSop(slug, patch)
            await writer.registerPath(updated.path)
            return asJson({ ok: true, type, action: 'update', id: updated.sop.id, slug, version: updated.sop.version, path: updated.path })
          }
          const input = inputFromArgs(args)
          if (input.type === 'preference') {
            const written = await store.upsertPreference(input)
            await writer.registerPath(written.path)
            return asJson({ ok: true, ...written })
          }
          if (input.type === 'pitfall') {
            const written = await store.upsertPitfall(input)
            await writer.registerPath(written.path)
            return asJson({ ok: true, ...written })
          }
          if (input.type === 'episodic') {
            const written = await store.appendLog(input)
            await writer.registerPath(written.path)
            return asJson({ ok: true, ...written })
          }
          if (input.type === 'fact') {
            const written = await store.upsertFact(input)
            await writer.registerPath(written.path)
            return asJson({ ok: true, ...written })
          }
          const written = await store.writeSop(input)
          await writer.registerPath(written.path)
          return asJson({ ok: true, id: written.sop.id, slug: written.sop.slug, version: written.sop.version, path: written.path })
        } catch (error) {
          throw asKnowledgeToolError(error)
        }
      },
    }),
    defineTool({
      name: 'memory_promote_sop',
      description: 'Promote one effective SOP to a DSH skill. Reserved for the memory guardian session. '
        + 'Writes $DSH_HOME/skills/<slug>/SKILL.md, updates an existing same-name skill, and deletes the SOP only after the skill is written.',
      parameters: {
        slug: { type: 'string', required: true, description: 'SOP slug to promote.' },
      },
      output: jsonOutput,
      execute: async (args: { slug?: string }, exec: { agent?: { id?: string } }) => {
        try {
          const caller = await requireGuardian(host, exec.agent?.id)
          const store = await host.storeFor(caller.userId)
          const writer = await host.graphWriterFor(caller.userId)
          const skillsRoot = await host.skillsRootFor(caller.userId)
          const slug = String(args.slug ?? '')
          const sops = await store.listSops()
          const sop = sops.find(entry => entry.slug === slug)
          if (sop === undefined) throw new KnowledgeToolError('not-found', 'no SOP with slug ' + JSON.stringify(slug))
          const skillPath = await promoteSopToSkill({
            sop: { id: sop.id, title: sop.title, body: sopBody(sop), slug: sop.slug, version: sop.version },
            skillsRoot,
          })
          const sopPath = join(store.memoryRoot, MEMORY_SOP_DIR, sop.slug + '.md')
          await deleteSopAfterPromotion({ sopPath, skillPath })
          await writer.syncAll()
          return asJson({ ok: true, slug, skillPath, promoted: true })
        } catch (error) {
          throw asKnowledgeToolError(error)
        }
      },
    }),
  ]
}

/** The current memory index, useful to the guardian before deciding a merge. */
export async function readMemoryIndexFor(store: MemoryStore): Promise<MemoryIndex> {
  return store.readMemoryIndex()
}
