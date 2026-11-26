/**
 * The transport an upload actually uses.
 *
 * Uploading with `fetch` is one request with no visibility into it: the browser reports
 * nothing until the whole body has gone, so a progress bar built on it can only be a
 * spinner. `XMLHttpRequest` exposes `upload.onprogress`, which is the only browser API
 * that reports bytes sent -- that is why this exists despite `fetch` being the modern
 * choice.
 *
 * Everything about the request other than the transport is unchanged: same URL, same
 * JSON body, same content type, same failure codes. The response is returned as a small
 * result object rather than a `Response`, because `XHR` does not produce one and every
 * caller here only needs "did it work, with which status, and what did the body say".
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

/** What one upload attempt reported. */
export interface UploadAttempt {
  /** HTTP status, or 0 when the request never completed (offline, DNS, abort). */
  status: number
  /** Parsed JSON body when it parsed, else undefined. */
  body: unknown
  /** Why the attempt did not complete, when the transport itself failed. */
  transportError?: string
}

/**
 * Report progress no more often than this.
 *
 * `upload.onprogress` can fire hundreds of times for a large file, and each event that
 * reaches React is a render of the whole task list. 100 ms keeps the bar smooth (10
 * updates a second is well past what an eye resolves) while bounding the work to ten
 * renders per second instead of hundreds.
 */
export const PROGRESS_INTERVAL_MS = 100

/**
 * Compute the integer percentage of bytes sent.
 *
 * Returns undefined when the total is unknown, which is a real case: a body sent without
 * a `Content-Length` reports `lengthComputable: false`, and inventing a percentage from
 * a missing denominator is exactly the dishonesty this module avoids.
 * @param loaded - bytes sent so far.
 * @param total - total bytes, when the browser knows it.
 * @param computable - whether the browser reported a usable total.
 * @returns 0-100, or undefined when it cannot be known.
 */
export function uploadPercent(loaded: number, total: number, computable: boolean): number | undefined {
  if (!computable || !Number.isFinite(total) || total <= 0) return undefined
  if (!Number.isFinite(loaded) || loaded < 0) return undefined
  // Clamped: a browser is allowed to report `loaded > total` for a trailing chunk, and a
  // "137%" bar is worse than one that sits at 100.
  return Math.min(100, Math.max(0, Math.round((loaded / total) * 100)))
}

/**
 * Whether enough time has passed to report another progress sample.
 *
 * Kept as a pure predicate so the throttle can be tested without a timer or a network.
 * @param now - the current timestamp in milliseconds.
 * @param last - when the last sample was reported, or undefined if none was.
 * @returns Whether this sample should be reported.
 */
export function shouldReportProgress(now: number, last: number | undefined): boolean {
  if (last === undefined) return true
  return now - last >= PROGRESS_INTERVAL_MS
}

/**
 * Upload one JSON body, reporting byte progress as it goes.
 * @param url - the route to post to.
 * @param payload - the JSON-serialisable body.
 * @param onProgress - called with 0-100 while sending; only called when a percentage is
 *   actually known, and throttled to {@link PROGRESS_INTERVAL_MS}.
 * @returns The attempt's outcome. Never rejects: a transport failure is a result, because
 *   the caller has to show it either way.
 */
export function uploadJsonWithProgress(
  url: string,
  payload: unknown,
  onProgress: (percent: number) => void,
): Promise<UploadAttempt> {
  return new Promise<UploadAttempt>((resolve) => {
    let settled = false
    let lastReport = -Infinity
    /** Resolve exactly once: XHR can fire both `error` and `loadend`. */
    const finish = (attempt: UploadAttempt): void => {
      if (settled) return
      settled = true
      resolve(attempt)
    }

    const request = new XMLHttpRequest()
    request.open('POST', url, true)
    request.setRequestHeader('content-type', 'application/json')

    request.upload.onprogress = (event: ProgressEvent): void => {
      const percent = uploadPercent(event.loaded, event.total, event.lengthComputable)
      if (percent === undefined) return
      const now = Date.now()
      if (!shouldReportProgress(now, lastReport)) return
      lastReport = now
      onProgress(percent)
    }

    request.onload = (): void => {
      let body: unknown
      try {
        body = JSON.parse(request.responseText) as unknown
      } catch {
        // A gateway answering 502 sends HTML; the caller falls back to the status code.
        body = undefined
      }
      finish({ status: request.status, body })
    }

    request.onerror = (): void => {
      finish({ status: 0, body: undefined, transportError: 'the network request failed' })
    }

    request.onabort = (): void => {
      finish({ status: 0, body: undefined, transportError: 'the upload was cancelled' })
    }

    request.ontimeout = (): void => {
      finish({ status: 0, body: undefined, transportError: 'the upload timed out' })
    }

    try {
      request.send(JSON.stringify(payload))
    } catch (error: unknown) {
      finish({
        status: 0,
        body: undefined,
        transportError: error instanceof Error ? error.message : 'the upload could not be started',
      })
    }
  })
}
