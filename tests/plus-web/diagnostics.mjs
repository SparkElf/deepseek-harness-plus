import { expect } from 'playwright/test'

const records = new WeakMap()
const navigationAbortAllowances = new WeakMap()

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
  page.on('pageerror', error => record.pageErrors.push(error.stack ?? error.message))
  page.on('console', message => {
    if (message.type() === 'error') record.consoleErrors.push(message.text())
  })
  page.on('requestfailed', request => {
    const error = request.failure()?.errorText ?? 'unknown failure'
    const rendered = `${request.method()} ${request.url()} :: ${error}`
    const path = new URL(request.url()).pathname
    const allowances = navigationAbortAllowances.get(page) ?? []
    const allowance = allowances.findIndex(candidate =>
      candidate.method === request.method() && candidate.path === path)
    if (error === 'net::ERR_ABORTED' && allowance >= 0) {
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

/** Allow one request to be cancelled by the next user-triggered page navigation. */
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
  expect(record.consoleErrors, 'browser console errors').toEqual([])
  expect(record.requestFailures, 'failed browser requests including CORS failures').toEqual([])
  expect(record.httpFailures, 'browser HTTP 4xx/5xx responses').toEqual([])
}
