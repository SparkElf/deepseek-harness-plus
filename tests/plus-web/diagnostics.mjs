import { expect } from 'playwright/test'

const records = new WeakMap()

export function watchDiagnostics(page) {
  const record = { pageErrors: [], consoleErrors: [], requestFailures: [], httpFailures: [] }
  records.set(page, record)
  page.on('pageerror', error => record.pageErrors.push(error.stack ?? error.message))
  page.on('console', message => {
    if (message.type() === 'error') record.consoleErrors.push(message.text())
  })
  page.on('requestfailed', request => {
    record.requestFailures.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? 'unknown failure'}`)
  })
  page.on('response', response => {
    if (response.status() >= 400) record.httpFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`)
  })
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
