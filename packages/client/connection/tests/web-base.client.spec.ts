// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWebUrl } from '../src/client/web-base.ts'

afterEach(() => {
  for (const base of document.querySelectorAll('base')) base.remove()
})

describe('browser carrier document base', () => {
  it('keeps API and plugin routes beneath a reverse-proxy mount', () => {
    const base = document.createElement('base')
    base.href = '/api/ai/workbench/dsh/web/'
    document.head.prepend(base)

    expect(resolveWebUrl('/api/session.list').pathname)
      .toBe('/api/ai/workbench/dsh/web/api/session.list')
    expect(resolveWebUrl('/plugins/example/client.js?rev=1').pathname)
      .toBe('/api/ai/workbench/dsh/web/plugins/example/client.js')
    expect(resolveWebUrl('/plugins/example/client.js?rev=1').search).toBe('?rev=1')
  })
})
