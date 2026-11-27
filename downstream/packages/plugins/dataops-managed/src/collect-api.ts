/**
 * DataOps spreadsheet-import transport for the collection skill.
 *
 * The host reads a workspace attachment, uploads it as multipart, and validates the
 * create-table or existing-table plan the current conversation model wrote. DataOps only
 * normalizes that plan and returns SQL/mapping summaries; it never selects or calls a shared
 * model. Execution is the single mutating call and stays behind the user's explicit
 * confirmation.
 *
 * @module collect-api
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { ReviewApi, ReviewApiResult } from './review-api.ts'

/** Largest spreadsheet the DataOps importer accepts. */
export const COLLECT_FILE_MAX_BYTES = 20 * 1024 * 1024
/** Extensions the importer understands. */
const SUPPORTED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv', '.tsv'])

/** One importable DataOps database destination. */
export interface CollectDataSource {
  urn: string
  name: string
  dbType: string | null
  databaseName: string | null
}

/** The preview payload DataOps returns for one uploaded workbook. */
export interface CollectPreview {
  sessionId: string
  file?: {
    name?: string
    sheetName?: string
    rowCount?: number
    columnCount?: number
  }
  sheetName?: string
  rowCount?: number
  columnCount?: number
  columns?: Array<Record<string, unknown>>
  [key: string]: unknown
}

/** The deterministic validation result: the normalized plan and its session context. */
export interface CollectValidatePlanResult {
  success?: boolean
  session?: Record<string, unknown>
  plan?: Record<string, unknown>
  [key: string]: unknown
}

/** The execute result; `resource` is the row DataOps upserted. */
export interface CollectExecuteResult {
  success?: boolean
  mode?: string
  targetTable?: { schema?: string; table?: string }
  totalRows?: number
  importedRows?: number
  skippedRows?: number
  errors?: unknown[]
  resource?: {
    id: number
    urn: string
    chineseName?: string | null
    accessLevel?: string
    aiVisible?: boolean
    created?: boolean
  }
  [key: string]: unknown
}

/** One resource row returned by the DataOps catalog. */
export interface CollectResourceRow {
  id: number
  urn: string
  chineseName?: string | null
  sourceTable?: string | null
  resourceType?: string
  rowCount?: number | null
  accessLevel?: string
  aiVisible?: boolean | null
}

const statusError = (result: ReviewApiResult, operation: string): Error => {
  const body = result.body as { error?: unknown; message?: unknown } | null
  const reason = typeof body?.error === 'string'
    ? body.error
    : typeof body?.message === 'string'
      ? body.message
      : ''
  if (result.status === 401) return new Error('Unauthorized (401): DataOps session expired')
  if (result.status === 403) return new Error('Forbidden (403): ' + (reason || 'the current role may not import resources'))
  return new Error(`${operation} failed: HTTP ${result.status}${reason ? ': ' + reason : ''}`)
}

const unwrap = <T>(result: ReviewApiResult, operation: string): T => {
  if (result.status < 200 || result.status >= 300) throw statusError(result, operation)
  return result.body as T
}

/** Read and validate one spreadsheet attachment from the workspace. */
export const readCollectFile = async (filePath: string): Promise<{ buffer: Buffer; fileName: string; sizeBytes: number }> => {
  const trimmed = filePath.trim()
  if (!trimmed) throw new Error('file_path is required')
  const extension = extname(trimmed).toLowerCase()
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error(`unsupported spreadsheet extension "${extension || '(none)'}"; expected .xlsx, .xls, .csv or .tsv`)
  }
  const info = await stat(trimmed)
  if (!info.isFile()) throw new Error(`not a regular file: ${trimmed}`)
  if (info.size <= 0) throw new Error(`empty file: ${trimmed}`)
  if (info.size > COLLECT_FILE_MAX_BYTES) {
    throw new Error(`file exceeds the ${(COLLECT_FILE_MAX_BYTES / 1024 / 1024).toFixed(0)}MB import limit`)
  }
  return {
    buffer: await readFile(trimmed),
    fileName: basename(trimmed),
    sizeBytes: info.size,
  }
}


/** Multipart part MIME from the spreadsheet extension; Blob defaults to octet-stream otherwise. */
function spreadsheetMimeType(fileName: string): string {
  const extension = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() ?? '' : ''
  if (extension === 'csv') return 'text/csv'
  if (extension === 'tsv') return 'text/tab-separated-values'
  if (extension === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (extension === 'xls') return 'application/vnd.ms-excel'
  return 'application/octet-stream'
}

/** Spreadsheet import calls bound to one workspace credential. */
export class CollectApi {
  constructor(private readonly reviewApi: ReviewApi) {}

  async preview(filePath: string): Promise<CollectPreview> {
    const file = await readCollectFile(filePath)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(file.buffer)], { type: spreadsheetMimeType(file.fileName) }), file.fileName)
    const result = await this.reviewApi.request('/api/resources/spreadsheet-import/preview', {
      method: 'POST',
      body: form,
    })
    return unwrap<CollectPreview>(result, 'spreadsheet preview')
  }

  async dataSources(): Promise<CollectDataSource[]> {
    const result = await this.reviewApi.request('/api/resources/spreadsheet-import/data-sources', { method: 'GET' })
    const body = unwrap<{ dataSources?: CollectDataSource[] }>(result, 'import data sources')
    return Array.isArray(body.dataSources) ? body.dataSources : []
  }

  /**
   * Validate and normalize a plan written by the current conversation model.
   *
   * Read-only and model-free: the backend runs the same deterministic sanitizers as
   * `/plan` and `/execute`, then returns the normalized plan, CREATE TABLE SQL or mapping
   * summary. It never resolves a shared `AiModelConfig` or calls a provider.
   */
  async validatePlan(payload: {
    sessionId: string
    dataSourceUrn?: string
    targetTable?: { schema: string; table: string }
    createPlan?: Record<string, unknown>
    mappings?: unknown[]
  }): Promise<CollectValidatePlanResult> {
    const result = await this.reviewApi.request('/api/resources/spreadsheet-import/validate-plan', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    return unwrap<CollectValidatePlanResult>(result, 'spreadsheet plan validation')
  }

  async execute(payload: Record<string, unknown>): Promise<CollectExecuteResult> {
    const result = await this.reviewApi.request('/api/resources/spreadsheet-import/execute', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    return unwrap<CollectExecuteResult>(result, 'spreadsheet execute')
  }

  async listResources(query = '', limit = 20): Promise<CollectResourceRow[]> {
    const result = await this.reviewApi.request('/api/resources', { method: 'GET' })
    const body = unwrap<{ resources?: CollectResourceRow[] }>(result, 'resource list')
    const rows = Array.isArray(body.resources) ? body.resources : []
    const keyword = query.trim().toLowerCase()
    return rows
      .filter((row) => row.resourceType === undefined || row.resourceType === 'TABLE')
      .filter((row) => {
        if (!keyword) return true
        return [row.chineseName, row.sourceTable, row.urn]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(keyword)
      })
      .slice(0, Math.max(1, Math.min(50, limit)))
  }
}