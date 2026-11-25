/** Same-origin tool-call timeout calls from the DataOps settings surface. */

/** Route the plugin's Host half serves for the tool-call timeout. */
export const TOOL_TIMEOUT_PATH = 'integrations/dataops/tool-timeout'

/** The two ends a timeout may take, in seconds, matching what the Host enforces. */
export const TOOL_TIMEOUT_MIN_SECONDS = 1
export const TOOL_TIMEOUT_MAX_SECONDS = 3600

/** The timeout as this workspace currently holds it. */
export interface ToolTimeout {
  /** How long one tool call may run before it is abandoned. */
  toolCallTimeoutMs: number
}

/** Narrow a response body to the timeout, rejecting anything else. */
function asTimeout(value: unknown): ToolTimeout | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const ms = (value as Record<string, unknown>).toolCallTimeoutMs
  return typeof ms === 'number' && Number.isSafeInteger(ms) && ms > 0 ? { toolCallTimeoutMs: ms } : null
}

/** Read the reason from a refused response, falling back to the status line. */
async function refusalReason(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as unknown
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      const error = (body as Record<string, unknown>).error
      if (typeof error === 'string' && error.trim() !== '') return error
    }
  } catch {
    // A body that is absent or not JSON leaves the fallback as the only explanation available.
  }
  return fallback + ' with HTTP ' + String(response.status)
}

/**
 * Read the tool-call timeout the panel shows.
 * @returns The timeout, or null when the workspace is not connected.
 */
export async function fetchToolTimeout(): Promise<ToolTimeout | null> {
  const response = await fetch(TOOL_TIMEOUT_PATH, { credentials: 'same-origin' })
  if (response.status === 503) return null
  if (!response.ok) throw new Error('Tool timeout read failed with HTTP ' + String(response.status))
  return asTimeout(await response.json())
}

/**
 * Store a new tool-call timeout.
 * @param milliseconds - How long one tool call may run.
 * @returns The stored timeout, or null when the workspace is not connected.
 */
export async function saveToolTimeout(milliseconds: number): Promise<ToolTimeout | null> {
  const response = await fetch(TOOL_TIMEOUT_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toolCallTimeoutMs: milliseconds }),
  })
  if (response.status === 503) return null
  // A refusal names a value the user chose, so the card keeps that draft and shows the reason.
  if (response.status === 400) throw new Error(await refusalReason(response, 'Tool timeout write refused'))
  if (!response.ok) throw new Error(await refusalReason(response, 'Tool timeout write failed'))
  return asTimeout(await response.json())
}
