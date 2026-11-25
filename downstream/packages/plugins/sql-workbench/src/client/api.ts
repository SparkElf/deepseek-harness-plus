// @ts-nocheck
import type { WorkbenchState } from '../types.ts'

/** 调用插件自有 Host API，返回领域值或抛出 Host 给出的完整错误。 */
export async function sqlApi<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch('/dsh-sql-workbench/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const value = await response.json() as T | { error: string; stack?: string }
  if (!response.ok) {
    const failure = value as { error: string; stack?: string }
    const error = new Error(failure.error)
    if (failure.stack !== undefined) error.stack = failure.stack
    throw error
  }
  return value as T
}

/** 订阅模型工具和其他浏览器动作造成的工作台状态更新。 */
export function subscribeSqlState(
  sessionId: string,
  onState: (state: WorkbenchState) => void,
  onError: (error: Error) => void,
): () => void {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(protocol + '//' + location.host + '/dsh-sql-workbench/ws?sessionId=' + encodeURIComponent(sessionId))
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)) as { type: 'state'; value: WorkbenchState }
    onState(message.value)
  })
  socket.addEventListener('error', () => { onError(new Error('SQL workbench WebSocket failed')) })
  return () => { socket.close() }
}
