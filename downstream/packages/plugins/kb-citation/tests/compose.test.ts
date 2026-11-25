import { beforeEach, describe, expect, it, vi } from 'vitest'
import { wrapCitationMentions } from '../src/client/compose.ts'
import { clearChunkCache } from '../src/client/citation-view.ts'

beforeEach(() => { clearChunkCache() })

function service(): any {
  return {
    calls: 0,
    forClosing() {
      this.calls += 1
      return { resolve: (value: string) => value === 'deliverable.md' ? { open: () => {}, label: 'deliverable', title: 'deliverable.md' } : undefined }
    },
  }
}

describe('chatFileMentions composition', () => {
  it('tries the KB resolver first and delegates every other token', () => {
    const base = service()
    const dispose = wrapCitationMentions(base, (value: string) => value.startsWith('kb://') ? { open: () => {}, label: 'kb', title: value } : undefined)
    const resolver = base.forClosing({}, 's')
    expect(resolver.resolve('kb://doc/d')).toMatchObject({ label: 'kb' })
    expect(resolver.resolve('deliverable.md')).toMatchObject({ label: 'deliverable' })
    dispose()
  })

  it('is idempotent and restores the exact original function on dispose', () => {
    const base = service()
    const original = base.forClosing
    const first = wrapCitationMentions(base, () => undefined)
    const second = wrapCitationMentions(base, () => undefined)
    second()
    expect(base.forClosing).not.toBe(original)
    first()
    expect(base.forClosing).toBe(original)
  })
})

describe('inline KB links', () => {
  it('maps .xlsx.md to the source .xlsx and uses the document tab', async () => {
    const { inlineCitationResolver } = await import('../src/client/compose.ts')
    const openFile = vi.fn(); const openDocument = vi.fn(() => true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: '/workspace/global/报表.xlsx', boxes: [], sheet: 'S1', cell: 'B2',
    }), { status: 200 })))
    const resolver = inlineCitationResolver({ openFile, openDocument })
    const link = resolver('kb://doc/49/chunk/335?path=' + encodeURIComponent('/workspace/global/报表.xlsx.md') + '&sheet=S1&cell=B2', { openFile }, 's1')!
    expect(link.label).toBe('报表.xlsx')
    link.open(); await new Promise(resolve => setTimeout(resolve, 80))
    expect(openDocument).toHaveBeenCalledWith('s1', '/workspace/kb/global/报表.xlsx')
    expect(openFile).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('maps .docx.md to the source .docx and keeps quote/chunk resolution', async () => {
    const { inlineCitationResolver } = await import('../src/client/compose.ts')
    const openFile = vi.fn(); const openDocument = vi.fn(() => true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: '/workspace/global/规则.docx', boxes: [], quote: '项目背景与整体定位',
    }), { status: 200 })))
    const resolver = inlineCitationResolver({ openFile, openDocument })
    const link = resolver('kb://doc/49/chunk/335?path=' + encodeURIComponent('/workspace/global/规则.docx.md'), { openFile }, 's1')!
    expect(link.label).toBe('规则.docx')
    link.open(); await new Promise(resolve => setTimeout(resolve, 80))
    expect(openDocument).toHaveBeenCalledWith('s1', '/workspace/kb/global/规则.docx')
    expect(openFile).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('inline path-only KB links', () => {
  it('parses a bare .xlsx.md path, maps the source file, and opens the document tab', async () => {
    const { parseCitationToken, originalOfficePath } = await import('../src/shared/citation.ts')
    const { inlineCitationResolver } = await import('../src/client/compose.ts')
    const path = '/workspace/global/rag-eval-fixtures/附件3、南宁市无人机培训和考场项目财务预测表.xlsx.md'
    const citation = parseCitationToken(path)!
    expect(citation.path).toBe('/workspace/kb/global/rag-eval-fixtures/附件3、南宁市无人机培训和考场项目财务预测表.xlsx.md')
    expect(originalOfficePath(citation.path!)).toBe('/workspace/kb/global/rag-eval-fixtures/附件3、南宁市无人机培训和考场项目财务预测表.xlsx')
    const openFile = vi.fn(); const openDocument = vi.fn(() => true)
    const resolver = inlineCitationResolver({ openFile, openDocument })
    const link = resolver(path, { openFile }, 's1')!
    expect(link.label).toBe('附件3、南宁市无人机培训和考场项目财务预测表.xlsx')
    link.open(); await new Promise(resolve => setTimeout(resolve, 80))
    expect(openDocument).toHaveBeenCalledWith('s1', '/workspace/kb/global/rag-eval-fixtures/附件3、南宁市无人机培训和考场项目财务预测表.xlsx')
  })
})
