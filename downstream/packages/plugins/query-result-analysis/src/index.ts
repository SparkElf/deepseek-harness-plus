/** Bounded, checkpointed batch analysis over a generic DSH `read_query_result` tool. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import z from '@deepseek-ai/schemastery'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const DEFAULT_READ_TOOL = 'mcp__dataops__read_query_result'
const ANALYSIS_REF_PREFIX = 'qa2_'
const ANALYSIS_REF_PATTERN = /^qa2_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const READ_PAGE_LIMIT = 2000
const ANALYSIS_PROVIDER = 'spawn'

type AnalysisRef = Branded<'QueryResultAnalysisRef'>

function parseAnalysisRef(value: string): AnalysisRef {
  if (!ANALYSIS_REF_PATTERN.test(value)) throw new Error('analysisRef is invalid')
  return value as AnalysisRef
}

export const name = 'query-result-analysis'
export const inject = ['tools', 'subagents']

/** Configuration for immutable-result paging and bounded durable analysis children. */
export interface Config {
  /** Fully qualified DSH tool name registered by the selected generic MCP client. */
  readToolName: string
  /** Maximum output tokens for one page analysis child. */
  batchOutputMaxTokens: number
  /** Maximum output tokens for one reduction child. */
  reduceOutputMaxTokens: number
  /** Maximum summaries supplied to one reduction child. */
  reduceGroupSize: number
}

/** Schemastery parser for analyzer composition. */
export const Config: z<Config> = z.object({
  readToolName: z.string().default(DEFAULT_READ_TOOL),
  batchOutputMaxTokens: z.number().min(1).step(1).default(1200),
  reduceOutputMaxTokens: z.number().min(1).step(1).default(1600),
  reduceGroupSize: z.number().min(2).step(1).default(8),
})

type ResultRow = Record<string, JsonValue>

type ResultPage = {
  columns: string[]
  items: ResultRow[]
  returnedCount: number
  totalCount: number
  hasMore: boolean
  nextCursor: string | null
}

type BatchCheckpoint = {
  batchIndex: number
  rowStart: number
  rowEnd: number
  nextCursor: string | null
  summary: string
  analysisSessionId: SessionId
}

type CompleteCheckpoint = {
  rowCount: number
  batchCount: number
  summary: string
  analysisSessionIds: SessionId[]
}

type AnalysisCheckpoint = {
  version: 2
  analysisRef: AnalysisRef
  sourceResultRef: string
  instruction: string
  createdAt: string
  batches: BatchCheckpoint[]
  complete?: CompleteCheckpoint
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function resultPagePayload(value: JsonValue): JsonValue {
  if (
    isRecord(value)
    && Array.isArray(value.content)
    && value.structuredContent !== undefined
  ) return value.structuredContent as JsonValue
  return value
}

function parseResultPage(value: JsonValue, readToolName: string): ResultPage {
  if (!isRecord(value)) throw new Error(`${readToolName} returned a non-object value`)
  const columns = value.columns
  const items = value.items
  const returnedCount = value.returnedCount
  const totalCount = value.totalCount
  const hasMore = value.hasMore
  const nextCursor = value.nextCursor
  if (
    !isStringArray(columns)
    || !Array.isArray(items)
    || items.some(item => !isRecord(item))
    || typeof returnedCount !== 'number'
    || !Number.isSafeInteger(returnedCount)
    || returnedCount < 0
    || returnedCount !== items.length
    || typeof totalCount !== 'number'
    || !Number.isSafeInteger(totalCount)
    || totalCount < returnedCount
    || typeof hasMore !== 'boolean'
    || !(nextCursor === null || typeof nextCursor === 'string')
    || (hasMore && (nextCursor === null || (nextCursor as string).length === 0))
    || (!hasMore && nextCursor !== null)
  ) {
    throw new Error(`${readToolName} returned an incompatible result page`)
  }
  return {
    columns,
    items: items as ResultRow[],
    returnedCount,
    totalCount,
    hasMore,
    nextCursor: nextCursor as string | null,
  }
}

function parseBatch(value: unknown): BatchCheckpoint | null {
  if (!isRecord(value)) return null
  if (
    typeof value.batchIndex !== 'number'
    || typeof value.rowStart !== 'number'
    || typeof value.rowEnd !== 'number'
    || !(value.nextCursor === null || typeof value.nextCursor === 'string')
    || typeof value.summary !== 'string'
    || typeof value.analysisSessionId !== 'string'
  ) return null
  return {
    batchIndex: value.batchIndex,
    rowStart: value.rowStart,
    rowEnd: value.rowEnd,
    nextCursor: value.nextCursor as string | null,
    summary: value.summary,
    analysisSessionId: SessionId(value.analysisSessionId),
  }
}

function parseComplete(value: unknown): CompleteCheckpoint | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.rowCount !== 'number'
    || typeof value.batchCount !== 'number'
    || typeof value.summary !== 'string'
    || !isStringArray(value.analysisSessionIds)
  ) return undefined
  return {
    rowCount: value.rowCount,
    batchCount: value.batchCount,
    summary: value.summary,
    analysisSessionIds: value.analysisSessionIds.map(SessionId),
  }
}

function parseCheckpoint(value: unknown): AnalysisCheckpoint {
  if (!isRecord(value)) throw new Error('analysis checkpoint is not an object')
  if (!Array.isArray(value.batches)) throw new Error('analysis checkpoint is incompatible')
  const batches = value.batches.map(parseBatch)
  if (
    value.version !== 2
    || typeof value.analysisRef !== 'string'
    || typeof value.sourceResultRef !== 'string'
    || typeof value.instruction !== 'string'
    || typeof value.createdAt !== 'string'
    || batches.some(batch => batch === null)
  ) throw new Error('analysis checkpoint is incompatible')
  const complete = value.complete === undefined ? undefined : parseComplete(value.complete)
  if (value.complete !== undefined && complete === undefined) {
    throw new Error('analysis checkpoint completion is incompatible')
  }
  return {
    version: 2,
    analysisRef: parseAnalysisRef(value.analysisRef),
    sourceResultRef: value.sourceResultRef,
    instruction: value.instruction,
    createdAt: value.createdAt,
    batches: batches as BatchCheckpoint[],
    ...(complete === undefined ? {} : { complete }),
  }
}

function checkpointRoot(): string {
  const dshHome = process.env.DSH_HOME?.trim()
  if (!dshHome) throw new Error('analyze_query_result requires DSH_HOME for durable checkpoints')
  return resolve(dshHome, 'query-result-analysis')
}

function sessionCheckpointDir(sessionId: SessionId): string {
  const sessionKey = createHash('sha256').update(sessionId, 'utf8').digest('hex')
  return resolve(checkpointRoot(), sessionKey)
}

function checkpointPath(sessionId: SessionId, analysisRef: AnalysisRef): string {
  return resolve(sessionCheckpointDir(sessionId), `${analysisRef}.json`)
}

async function writeCheckpoint(sessionId: SessionId, checkpoint: AnalysisCheckpoint): Promise<void> {
  const path = checkpointPath(sessionId, checkpoint.analysisRef)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${randomUUID()}`
  await writeFile(temporary, JSON.stringify(checkpoint), 'utf8')
  await rename(temporary, path)
}

async function readCheckpoint(ctx: Context, sessionId: SessionId, analysisRef: AnalysisRef): Promise<AnalysisCheckpoint> {
  const path = checkpointPath(sessionId, analysisRef)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    ctx.logger.error('query-result-analysis: checkpoint read failed')
    ctx.logger.error(error)
    throw new Error(`analysisRef ${analysisRef} does not exist for this session`, { cause: error })
  }
  try {
    return parseCheckpoint(JSON.parse(text) as unknown)
  } catch (error) {
    ctx.logger.error('query-result-analysis: checkpoint parse failed')
    ctx.logger.error(error)
    if (error instanceof Error && error.message.startsWith('analysis checkpoint')) throw error
    throw new Error('analysis checkpoint is incompatible', { cause: error })
  }
}

type AnalysisModelResult = {
  summary: string
  sessionId: SessionId
}

function childAgentOptions(config: LlmCallConfig, maxTokens: number): AgentOptions {
  return {
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    maxTokens: Math.min(config.maxTokens ?? maxTokens, maxTokens),
  }
}

function assistantText(output: readonly ContentBlock[]): string {
  const text = output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
  if (text.length === 0) throw new Error('analysis child returned no assistant text')
  return text
}

/**
 * 每次分析模型调用都由持久子会话拥有，确保输入、请求配置、重试和输出可从 session log 重建。
 */
async function runAnalysisChild(
  ctx: Context,
  parent: Agent,
  modelConfig: LlmCallConfig,
  signal: AbortSignal,
  label: string,
  persona: string,
  prompt: string,
  maxTokens: number,
): Promise<AnalysisModelResult> {
  const run = await ctx.subagents.start(ANALYSIS_PROVIDER, {
    label,
    prompt: [{ type: 'text', text: prompt }],
    parent,
    signal,
    agentOptions: childAgentOptions(modelConfig, maxTokens),
    toolFilter: { allow: [] },
    persona,
  })
  try {
    const result = await run.result
    if (result.stopReason !== 'completed') {
      const detail = result.diagnostic === undefined ? '' : `: ${result.diagnostic}`
      throw new Error(`analysis child stopped with ${result.stopReason}${detail}`)
    }
    return { summary: assistantText(result.output), sessionId: run.id }
  } finally {
    await run.dispose()
  }
}

async function readPage(
  ctx: Context,
  exec: ToolRunContext,
  resultRef: string,
  readToolName: string,
  cursor?: string | null,
): Promise<ResultPage> {
  const result = await ctx.tools.execute({
    callId: `${exec.callId}:query-analysis:${randomUUID()}` as ToolRunContext['callId'],
    rootCallId: exec.rootCallId,
    name: readToolName,
    arguments: {
      resultRef,
      limit: READ_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    },
    agent: exec.agent,
    parent: exec.token,
    signal: exec.signal,
  })
  for (const context of result.additionalContexts ?? []) exec.deferContext(context)
  if (result.isError) throw new Error(`${readToolName} failed: ${result.error.message}`)
  return parseResultPage(resultPagePayload(result.value), readToolName)
}

function batchPrompt(input: {
  sourceResultRef: string
  instruction: string
  batchIndex: number
  rowStart: number
  rows: ResultRow[]
}) {
  const rows = input.rows.map((row, index) => ({
    rowRef: `${input.sourceResultRef}#row-${input.rowStart + index}`,
    data: row,
  }))
  return JSON.stringify({
    task: input.instruction,
    sourceResultRef: input.sourceResultRef,
    batchIndex: input.batchIndex,
    rows,
  })
}

const BATCH_SYSTEM = [
  'Analyze only the supplied immutable query-result rows for the requested task.',
  'Return a concise batch finding in plain text.',
  'Cite the supplied rowRef values for specific evidence when useful.',
  'Do not claim facts about rows outside this batch.',
].join(' ')

const REDUCE_SYSTEM = [
  'Synthesize bounded batch analyses of one immutable query result into one final answer.',
  'Preserve important rowRef citations from the batch analyses.',
  'Resolve duplication across batches and state material patterns, exceptions, and limitations.',
  'Do not invent facts that are absent from the batch analyses.',
].join(' ')

type ReductionResult = {
  summary: string
  sessionIds: SessionId[]
}

/** 按配置的固定组宽顺序归并，避免把完整结果再次送入单个模型上下文。 */
async function reduceSummaries(
  ctx: Context,
  config: Config,
  parent: Agent,
  modelConfig: LlmCallConfig,
  analysisRef: AnalysisRef,
  instruction: string,
  summaries: string[],
  signal: AbortSignal,
): Promise<ReductionResult> {
  if (summaries.length === 0) {
    return { summary: 'The query result contains no rows to analyze.', sessionIds: [] }
  }
  let layer = summaries.map((summary, index) => ({ id: `batch-${index + 1}`, summary }))
  const sessionIds: SessionId[] = []
  let layerIndex = 1
  while (layer.length > 1) {
    const next: Array<{ id: string; summary: string }> = []
    for (let offset = 0; offset < layer.length; offset += config.reduceGroupSize) {
      const group = layer.slice(offset, offset + config.reduceGroupSize)
      const groupIndex = Math.floor(offset / config.reduceGroupSize) + 1
      const result = await runAnalysisChild(
        ctx,
        parent,
        modelConfig,
        signal,
        `Analysis ${analysisRef} reduce ${layerIndex}.${groupIndex}`,
        REDUCE_SYSTEM,
        JSON.stringify({ task: instruction, analyses: group }),
        config.reduceOutputMaxTokens,
      )
      sessionIds.push(result.sessionId)
      next.push({ id: `reduce-${layerIndex}-${groupIndex}`, summary: result.summary })
    }
    layer = next
    layerIndex += 1
  }
  return { summary: layer[0]!.summary, sessionIds }
}

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'analyze_query_result',
    description: 'Analyze an entire immutable query result with bounded model batches. The tool repeatedly invokes the visible read_query_result capability under the same Agent, runs every analysis and reduction call in a durable child session, checkpoints completed pages under DSH_HOME, and hierarchically reduces batch findings. Use resumeAnalysisRef to continue an interrupted analysis without rereading completed pages.',
    parameters: {
      resultRef: {
        type: 'string',
        required: true,
        description: 'Opaque immutable query result reference to analyze completely.',
      },
      instruction: {
        type: 'string',
        required: true,
        description: 'The business or analytical question to answer across all result rows.',
      },
      resumeAnalysisRef: {
        type: 'string',
        description: 'Optional analysisRef from an interrupted prior call in this same DSH session.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          analysisRef: { type: 'string', required: true },
          sourceResultRef: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          rowCount: { type: 'integer', required: true },
          batchCount: { type: 'integer', required: true },
          resumed: { type: 'boolean', required: true },
          analysisSessionIds: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('analyze_query_result requires an Agent-owned tool execution')
      const resultRef = args.resultRef.trim()
      const instruction = args.instruction.trim()
      if (resultRef.length === 0) throw new Error('resultRef must be non-empty')
      if (instruction.length === 0) throw new Error('instruction must be non-empty')
      const header = agent.session.requestHeader()
      if (header === undefined) throw new Error('analyze_query_result requires an active model request header')
      const modelConfig = header.config
      const resumeAnalysisRef = args.resumeAnalysisRef
      const resumed = resumeAnalysisRef !== undefined
      const analysisRef = resumeAnalysisRef === undefined
        ? parseAnalysisRef(`${ANALYSIS_REF_PREFIX}${randomUUID()}`)
        : parseAnalysisRef(resumeAnalysisRef.trim())

      let checkpoint: AnalysisCheckpoint
      if (resumed) {
        checkpoint = await readCheckpoint(ctx, agent.id, analysisRef)
        if (checkpoint.sourceResultRef !== resultRef || checkpoint.instruction !== instruction) {
          throw new Error('resumeAnalysisRef belongs to a different resultRef or instruction')
        }
        if (checkpoint.complete !== undefined) {
          return {
            analysisRef,
            sourceResultRef: resultRef,
            summary: checkpoint.complete.summary,
            rowCount: checkpoint.complete.rowCount,
            batchCount: checkpoint.complete.batchCount,
            resumed: true,
            analysisSessionIds: checkpoint.complete.analysisSessionIds,
          }
        }
      } else {
        checkpoint = {
          version: 2,
          analysisRef,
          sourceResultRef: resultRef,
          instruction,
          createdAt: new Date().toISOString(),
          batches: [],
        }
        await writeCheckpoint(agent.id, checkpoint)
      }

      const last = checkpoint.batches.at(-1)
      let cursor: string | null | undefined = last?.nextCursor
      let rowCount = last?.rowEnd ?? 0
      let batchIndex = last === undefined ? 0 : last.batchIndex + 1
      const summaries = checkpoint.batches.map(batch => batch.summary)

      try {
        while (cursor !== null) {
          const page = await readPage(ctx, exec, resultRef, config.readToolName, cursor)
          if (page.items.length === 0 && !page.hasMore) {
            cursor = null
            break
          }
          const rowStart = rowCount + 1
          const batchResult = await runAnalysisChild(
            ctx,
            agent,
            modelConfig,
            exec.signal,
            `Analysis ${analysisRef} batch ${batchIndex + 1}`,
            BATCH_SYSTEM,
            batchPrompt({
              sourceResultRef: resultRef,
              instruction,
              batchIndex,
              rowStart,
              rows: page.items,
            }),
            config.batchOutputMaxTokens,
          )
          const summary = batchResult.summary
          rowCount += page.items.length
          cursor = page.hasMore ? page.nextCursor : null
          const batch: BatchCheckpoint = {
            batchIndex,
            rowStart,
            rowEnd: rowCount,
            nextCursor: cursor ?? null,
            summary,
            analysisSessionId: batchResult.sessionId,
          }
          checkpoint.batches.push(batch)
          await writeCheckpoint(agent.id, checkpoint)
          summaries.push(summary)
          batchIndex += 1
        }

        const reduction = await reduceSummaries(
          ctx,
          config,
          agent,
          modelConfig,
          analysisRef,
          instruction,
          summaries,
          exec.signal,
        )
        const analysisSessionIds = [
          ...checkpoint.batches.map(batch => batch.analysisSessionId),
          ...reduction.sessionIds,
        ]
        checkpoint.complete = {
          rowCount,
          batchCount: summaries.length,
          summary: reduction.summary,
          analysisSessionIds,
        }
        await writeCheckpoint(agent.id, checkpoint)
        return {
          analysisRef,
          sourceResultRef: resultRef,
          summary: reduction.summary,
          rowCount,
          batchCount: summaries.length,
          resumed,
          analysisSessionIds,
        }
      } catch (error) {
        ctx.logger.error('query-result-analysis: analysis interrupted')
        ctx.logger.error(error)
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message}. Resume with resumeAnalysisRef=${analysisRef}`, { cause: error })
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Analyze complete query result',
      kind: 'other',
      rawInput: {
        resultRef: args.resultRef,
        ...(args.resumeAnalysisRef ? { resumeAnalysisRef: args.resumeAnalysisRef } : {}),
      },
    }),
  }))
}
