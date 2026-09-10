import { expect } from 'playwright/test'

const records = new WeakMap()
const navigationAbortAllowances = new WeakMap()
const runtimeRestartWindows = new WeakMap()

export function watchDiagnostics(page) {
  const record = {
    pageErrors: [],
    consoleErrors: [],
    requestFailures: [],
    intentionalCancellations: [],
    httpFailures: [],
  }
  records.set(page, record)
  navigationAbortAllowances.set(page, [])
  runtimeRestartWindows.set(page, false)
  page.on('pageerror', error => record.pageErrors.push(error.stack ?? error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const text = message.text()
    const expectedRestartDisconnect = runtimeRestartWindows.get(page) === true
      && /(ERR_CONNECTION_REFUSED|ERR_INCOMPLETE_CHUNKED_ENCODING|Connection closed before receiving a handshake response)/u.test(text)
    if (expectedRestartDisconnect) record.intentionalCancellations.push(text)
    else record.consoleErrors.push(`${text} @ ${JSON.stringify(message.location())}`)
  })
  page.on('requestfailed', request => {
    const error = request.failure()?.errorText ?? 'unknown failure'
    const rendered = `${request.method()} ${request.url()} :: ${error}`
    const path = new URL(request.url()).pathname
    const allowances = navigationAbortAllowances.get(page) ?? []
    const allowance = allowances.findIndex(candidate =>
      candidate.method === request.method() && candidate.path === path)
    const expectedRestartRequest = runtimeRestartWindows.get(page) === true
      && request.method() === 'GET'
      && path === '/plugins/events'
      && (error === 'net::ERR_INCOMPLETE_CHUNKED_ENCODING' || error === 'net::ERR_CONNECTION_REFUSED')
    if (expectedRestartRequest) {
      record.intentionalCancellations.push(rendered)
    } else if (error === 'net::ERR_ABORTED' && allowance >= 0) {
      allowances.splice(allowance, 1)
      record.intentionalCancellations.push(rendered)
    } else if (request.method() === 'HEAD' && path.endsWith('/api/session.export') && error === 'net::ERR_ABORTED') {
      record.intentionalCancellations.push(rendered)
    } else {
      record.requestFailures.push(rendered)
    }
  })
  page.on('response', response => {
    if (response.status() >= 400) record.httpFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`)
  })
}

/** Mark the interval in which a user-triggered runtime restart deliberately drops browser transports. */
export function beginRuntimeRestart(page) {
  if (!runtimeRestartWindows.has(page)) throw new Error('Browser diagnostics were not installed')
  runtimeRestartWindows.set(page, true)
}

/** End the user-triggered runtime restart interval after the Session reconnects. */
export function endRuntimeRestart(page) {
  if (!runtimeRestartWindows.has(page)) throw new Error('Browser diagnostics were not installed')
  runtimeRestartWindows.set(page, false)
}

/** Allow one exact request cancellation when the user-visible navigation or download result is asserted separately. */
export function allowNextNavigationAbort(page, method, path) {
  const allowances = navigationAbortAllowances.get(page)
  if (allowances === undefined) throw new Error('Browser diagnostics were not installed')
  allowances.push({ method, path })
}

export async function assertDiagnostics(page, testInfo) {
  const record = records.get(page)
  if (record === undefined) throw new Error('Browser diagnostics were not installed')
  await testInfo.attach('browser-diagnostics.json', {
    body: Buffer.from(JSON.stringify(record, null, 2) + '\n'),
    contentType: 'application/json',
  })
  expect(record.pageErrors, 'page errors with full stack').toEqual([])
  const expectedFilemanagerIconMiss = /^404 GET https?:\/\/[^/]+\/open-in-app\/icon\/filemanager$/u
  // A host that declares a catalog id iconless serves no icon for it, and the
  // browser reports one console error per request; drop exactly as many as the
  // matching HTTP failures, never a console error that has no such failure.
  // Better Sidebar keeps two model-driven channels closed unless its settings open
  // them, and its client logs one give-up line per closed channel on load. The
  // sidebar itself is mounted and serving: its own API route answers. Drop only
  // those give-up lines, never another message from the same plugin.
  const closedSidebarChannel = /^\[dsh-better-sidebar\] agent-(?:opens|terminals) connection failed; stopping reconnect loop/u
  const consoleErrors = [...record.consoleErrors].filter(error => !closedSidebarChannel.test(error))
  let remainingIconMisses = record.httpFailures.filter(failure => expectedFilemanagerIconMiss.test(failure)).length
  for (let index = consoleErrors.length - 1; index >= 0 && remainingIconMisses > 0; index -= 1) {
    if (!consoleErrors[index].startsWith('Failed to load resource: the server responded with a status of 404 (Not Found)')) continue
    consoleErrors.splice(index, 1)
    remainingIconMisses -= 1
  }
  expect(consoleErrors, `browser console errors; HTTP failures: ${record.httpFailures.join(' | ')}`).toEqual([])
  expect(record.requestFailures, 'failed browser requests including CORS failures').toEqual([])
  expect(record.httpFailures.filter(failure => !expectedFilemanagerIconMiss.test(failure)), 'browser HTTP 4xx/5xx responses').toEqual([])
}
