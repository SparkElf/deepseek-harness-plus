import { describe, expect, it } from 'vitest'
import { injectDocumentBase, relativizePluginPreloads } from '../src/index.ts'

describe('reverse-proxy document base', () => {
  it('places the base element before parser-blocking preload scripts', () => {
    const tapped = '<html><head><script src="/plugins/runtime/client.js"></script><title>DSH</title></head><body></body></html>'
    const html = relativizePluginPreloads(injectDocumentBase(tapped, '/api/ai/workbench/dsh/web'))

    expect(html).toContain('<base href="/api/ai/workbench/dsh/web/">')
    expect(html).toContain('src="plugins/runtime/client.js"')
    expect(html.indexOf('<base ')).toBeLessThan(html.indexOf('<script '))
  })

  it('keeps root deployment canonical', () => {
    expect(injectDocumentBase('<head></head>', '')).toBe('<head><base href="/"></head>')
  })
})
