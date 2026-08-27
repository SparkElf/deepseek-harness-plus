// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDocumentBundleUrl } from '../src/client/system.ts'

afterEach(() => {
  for (const base of document.querySelectorAll('base')) base.remove()
})

describe('client bundle document base', () => {
  it('rewrites host graph root URLs beneath the reverse-proxy mount', () => {
    const base = document.createElement('base')
    base.href = '/api/ai/workbench/dsh/web/'
    document.head.prepend(base)

    const resolved = new URL(resolveDocumentBundleUrl('/plugins/runtime/client.js?rev=abc'))
    expect(resolved.pathname).toBe('/api/ai/workbench/dsh/web/plugins/runtime/client.js')
    expect(resolved.search).toBe('?rev=abc')
  })
})
