import { describe, expect, it } from 'vitest'
import { DocumentParserError } from '@deepseek-ai/dsh-document-parser'
import { parseArchive } from '../src/provider.ts'

const text = (value: string): Uint8Array => new TextEncoder().encode(value)

describe('MinerU parser archive projection', () => {
  it('keeps complete markdown, the v1 content list, and ordered extracted images', () => {
    const result = parseArchive({
      'report/report.md': text('# Report\n\nComplete body.'),
      'report/report_content_list.json': text('[{"type":"text","text":"Complete body."}]'),
      'report/report_content_list_v2.json': text('{"ignored":"v2"}'),
      'report/images/figure-1.png': new Uint8Array([137, 80, 78, 71]),
      'report/images/figure-2.jpg': new Uint8Array([255, 216, 255, 224]),
    })

    expect(new TextDecoder().decode(result.markdown)).toBe('# Report\n\nComplete body.')
    expect(JSON.parse(new TextDecoder().decode(result.contentList))).toEqual([
      { type: 'text', text: 'Complete body.' },
    ])
    expect(result.images.map(image => [image.name, image.mediaType])).toEqual([
      ['figure-1.png', 'image/png'],
      ['figure-2.jpg', 'image/jpeg'],
    ])
  })

  it('rejects an ambiguous markdown archive instead of guessing', () => {
    expect(() => parseArchive({
      'report/a.md': text('a'),
      'report/b.md': text('b'),
      'report/report_content_list.json': text('[]'),
    })).toThrowError(DocumentParserError)
  })

  it('rejects a non-array content list', () => {
    expect(() => parseArchive({
      'report/report.md': text('body'),
      'report/report_content_list.json': text('{"type":"text"}'),
    })).toThrowError(/content-list output is not a JSON array/)
  })

  it('rejects unsupported extracted image formats', () => {
    expect(() => parseArchive({
      'report/report.md': text('body'),
      'report/report_content_list.json': text('[]'),
      'report/images/vector.svg': text('<svg/>'),
    })).toThrowError(/unsupported extracted image type/)
  })
})
