/**
 * Opt-in citation navigation timing.
 *
 * The latency of a citation click is a product property, not a debugging detail: a reader who
 * waits several seconds assumes the click did nothing. Recording named marks is cheap when the
 * flag is off and gives both the E2E suite and a field diagnosis one timeline to compare.
 *
 * Enable from a page before the click:
 *   window.__KB_CITATION_TIMING__ = true
 */

/** One named point on the click-to-first-box timeline. */
export interface CitationTimingEvent {
  readonly name: string
  /** `performance.now()` milliseconds at the mark. */
  readonly at: number
  readonly detail?: string
}

const TIMING_FLAG = '__KB_CITATION_TIMING__'
const events: CitationTimingEvent[] = []

function timingEnabled(): boolean {
  const host = globalThis as { [TIMING_FLAG]?: unknown } & { window?: { [TIMING_FLAG]?: unknown } }
  return host[TIMING_FLAG] === true || host.window?.[TIMING_FLAG] === true
}

/** Record one stage mark; silent unless the page opted in. */
export function markCitationTiming(name: string, detail?: string): void {
  if (!timingEnabled()) return
  const at = typeof performance === 'undefined' ? Date.now() : performance.now()
  const event: CitationTimingEvent = { name, at, ...(detail === undefined ? {} : { detail }) }
  events.push(event)
  // A single console line per stage keeps the browser trace readable without a custom panel.
  console.debug('[kbtiming]', name, Math.round(at), detail ?? '')
}

/** Every mark recorded in this page, oldest first. */
export function citationTimingEvents(): readonly CitationTimingEvent[] {
  return events
}

/** Clear marks between E2E clicks. */
export function resetCitationTiming(): void {
  events.length = 0
}

/**
 * Opt-in structural diagnostics for the amber query-hit path.
 *
 * Amber boxes are a second, quieter contract on top of the blue chunk union: they are correct
 * when they land and invisible when a term never reaches the matcher, so a field report of
 * "0 hits" needs the term list, the page text and the matcher's decision in one place. This
 * records that state on `window.__kbCitationDebug` only when the page opted in, which keeps the
 * production path free of retained references.
 */
const DEBUG_FLAG = '__KB_CITATION_DEBUG__'

function debugEnabled(): boolean {
  const host = globalThis as { [DEBUG_FLAG]?: unknown; __KB_CITATION_TIMING__?: unknown; window?: { [DEBUG_FLAG]?: unknown; __KB_CITATION_TIMING__?: unknown } }
  return host[DEBUG_FLAG] === true || host.__KB_CITATION_TIMING__ === true
    || host.window?.[DEBUG_FLAG] === true || host.window?.__KB_CITATION_TIMING__ === true
}

/** One structural record; `key` names the stage and later writes replace earlier ones. */
export function recordCitationDebug(key: string, value: unknown): void {
  if (!debugEnabled()) return
  const host = globalThis as { __kbCitationDebug?: Record<string, unknown> }
  const bag = host.__kbCitationDebug ?? (host.__kbCitationDebug = {})
  bag[key] = value
}