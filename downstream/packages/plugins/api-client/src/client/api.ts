import type { ApiClientState, ApiResponse } from '../types.ts'
import type { ApiExchangeFormat, ApiExportDocument } from '../import-export.ts'

export async function apiClientCall<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch('/dsh-api-client/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  const value = await response.json() as T | { error: string }
  if (!response.ok) throw new Error((value as { error: string }).error)
  return value as T
}
export function loadApiState(): Promise<ApiClientState> { return apiClientCall('state') }
export interface ExecuteResult { response: ApiResponse; state: ApiClientState }
export interface ImportResult { workspaceId: string; state: ApiClientState }
export type ExportResult = ApiExportDocument
export type { ApiExchangeFormat }
