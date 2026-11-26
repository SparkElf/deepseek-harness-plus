/**
 * `.md` 文件不该被当成「没有解析器」。
 *
 * 用户报的是：两个 `.md` 文件在进度弹窗里都显示「该文件类型无解析器」。这既是状态判定
 * 错误，也是**反馈方向错误**——它告诉读者自己的 Markdown 文件读不了。
 *
 * 三层都要对：`isAlreadyMarkdown` 认识扩展名、队列把 `.md` 判成 `already-markdown`
 * 而不是 `unsupported`、UI 文案把那两种状态分开说。
 */
import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { EXTRACTABLE_EXTENSIONS, isAlreadyMarkdown, isExtractable } from '../src/extract.ts'

describe('a Markdown document needs no extractor', () => {
  it('recognises the Markdown extensions', () => {
    // `.md` 是最常见的，其余是同一族写法，一并认掉。
    for (const path of ['a.md', 'dir/a.md', 'A.MD', 'notes.markdown', 'x.mdown', 'y.mkd']) {
      expect(isAlreadyMarkdown(path), path).toBe(true)
    }
  })

  it('does not claim a document that needs parsing', () => {
    // 这些是真正需要解析器的类型；把 `.md` 的判定放宽成"所有文本"会漏掉它们。
    for (const path of ['a.pdf', 'b.docx', 'c.xlsx', 'd.pptx', 'e.rtf']) {
      expect(isAlreadyMarkdown(path), path).toBe(false)
    }
  })

  it('does not mistake a name that merely contains md', () => {
    // `readme.md.bak` 不是 Markdown：扩展名取的是最后一段。
    expect(isAlreadyMarkdown('readme.md.bak')).toBe(false)
    expect(isAlreadyMarkdown('mdfile.txt')).toBe(false)
  })

  it('is checked before the unsupported branch', async () => {
    // 这是缺陷的准确位置：`.md` 不在可提取列表里，所以先问 `isExtractable` 就会落到
    // `unsupported`。源码顺序保证 `.md` 先被认出来。
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    const already = source.indexOf('isAlreadyMarkdown(relPath)')
    const unsupported = source.indexOf("outcome: 'unsupported'")
    expect(already).toBeGreaterThan(0)
    expect(unsupported).toBeGreaterThan(0)
    expect(already, 'isAlreadyMarkdown 必须先于 unsupported 分支').toBeLessThan(unsupported)
  })

  it('gives the queue a state that is neither success-by-extraction nor failure', async () => {
    // `already-markdown` 与 `succeeded`（写了 .md 兄弟）和 `unsupported`（没有解析器）
    // 都不同：它表示"本来就不需要做"。合成任何一个都会说谎。
    const queue = await readFile(new URL('../src/extractionQueue.ts', import.meta.url), 'utf8')
    expect(queue).toContain("'already-markdown'")
    // 队列判定也要先问 Markdown，再问可提取性。
    const mdCheck = queue.indexOf('options.isAlreadyMarkdown(relPath)')
    const extractable = queue.indexOf('options.isExtractable(relPath)')
    expect(mdCheck).toBeGreaterThan(0)
    expect(extractable).toBeGreaterThan(0)
    expect(mdCheck, 'enqueue 必须先判 Markdown').toBeLessThan(extractable)
  })

  it('says the right thing in the panel, in both locales', async () => {
    // UI 文案必须区分两种状态：一个是"无需提取"（成功），一个是"没有解析器"（失败）。
    const panel = await readFile(new URL('../src/client/KnowledgeProgressPopover.tsx', import.meta.url), 'utf8')
    expect(panel).toContain("t('progressAlreadyMarkdown')")
    const locales = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
    expect(locales.match(/progressAlreadyMarkdown:/gu)?.length, 'en 和 zh 各一份').toBe(2)
  })

  it('accepts legacy Office formats through the same extraction path', () => {
    // `.doc`/`.xls`/`.ppt` are binary containers, not "unsupported". The
    // extractor routes them through LibreOffice and, on a lossy text filter,
    // through a modern-container conversion.
    for (const ext of ['.doc', '.xls', '.ppt', '.rtf', '.odt', '.ods', '.odp']) {
      expect(EXTRACTABLE_EXTENSIONS, ext).toContain(ext)
      expect(isExtractable('legacy' + ext), ext).toBe(true)
    }
    expect(isExtractable('legacy.doc')).toBe(true)
    expect(isExtractable('legacy.DOC')).toBe(true)
  })
})
