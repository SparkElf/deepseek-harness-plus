/**
 * 主页文档表的分页。
 *
 * 表里有两张表：共享表早就有分页，主表（标题/位置/所有者/创建时间/最近访问/操作）没有，
 * 所以文档一多就成了一条没有尽头的列表。
 *
 * 这些用例钉的是主表用到的两个决定：什么时候出现分页控件，以及当前页裁剪出哪些行。
 * 它们不渲染组件——分页是否正确与 React 无关，把它绑到 DOM 上只会让测试更脆。
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PAGE_SIZE, needsPager, paginate } from '../src/client/paging.ts'

/** A list of fake rows, the way the table holds documents. */
const rows = Array.from({ length: 45 }, (_, index) => ({ relPath: 'doc-' + String(index) + '.md' }))

describe('the document table pages at the shared page size', () => {
  it('shows the pager only when there is more than one page', () => {
    // 一页装得下时不画控件：显示「1 / 1」是在暗示读者漏了什么。
    expect(needsPager(0, DEFAULT_PAGE_SIZE)).toBe(false)
    expect(needsPager(DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE)).toBe(false)
    expect(needsPager(DEFAULT_PAGE_SIZE + 1, DEFAULT_PAGE_SIZE)).toBe(true)
    expect(needsPager(45, DEFAULT_PAGE_SIZE)).toBe(true)
  })

  it('slices the first page from the top of the list', () => {
    const page = paginate(rows, 1, DEFAULT_PAGE_SIZE)
    expect(page.rows).toHaveLength(DEFAULT_PAGE_SIZE)
    expect(page.rows[0]?.relPath).toBe('doc-0.md')
    expect(page.page).toBe(1)
    expect(page.pageCount).toBe(3)
    expect(page.total).toBe(45)
  })

  it('gives the last page only the rows that are left', () => {
    // 45 行、每页 20 → 第三页只有 5 行，不能补空行，也不能重复上一页的行。
    const page = paginate(rows, 3, DEFAULT_PAGE_SIZE)
    expect(page.rows).toHaveLength(5)
    expect(page.rows[0]?.relPath).toBe('doc-40.md')
    expect(page.page).toBe(3)
  })

  it('shows different rows on each page', () => {
    // 切页必须换内容，否则控件看起来在动、表格没动。
    const first = paginate(rows, 1, DEFAULT_PAGE_SIZE).rows.map(row => row.relPath)
    const second = paginate(rows, 2, DEFAULT_PAGE_SIZE).rows.map(row => row.relPath)
    expect(first).not.toEqual(second)
    expect(first.filter(path => second.includes(path))).toEqual([])
  })

  it('walks every row exactly once across the pages', () => {
    // 分页是一种划分：把所有页拼起来必须等于原列表，不多不少。
    const collected = [1, 2, 3].flatMap(page => paginate(rows, page, DEFAULT_PAGE_SIZE).rows.map(row => row.relPath))
    expect(collected).toEqual(rows.map(row => row.relPath))
  })

  it('clamps a page index past the end instead of rendering nothing', () => {
    // 切换标签页会让行数变化，而页码还停在原处；不裁剪就会得到一张空表。
    const page = paginate(rows, 99, DEFAULT_PAGE_SIZE)
    expect(page.page).toBe(page.pageCount)
    expect(page.rows).toHaveLength(5)
  })

  it('never reports page 1 of 0', () => {
    // 空表时控件本来不画，但读数也必须是自洽的。
    const page = paginate([], 1, DEFAULT_PAGE_SIZE)
    expect(page.pageCount).toBe(1)
    expect(page.page).toBe(1)
    expect(page.rows).toEqual([])
  })
})

describe('the document table is actually wired to the pager', () => {
  /**
   * 上一组用例只验证了 `paging.ts` 的算术，**没有验证表格是否真的用了它**：
   * 把表格改回渲染整表，那 7 条依然全绿。这是一个真实的测试盲区——分页函数正确，
   * 功能却没接上。
   *
   * 这里读源码钉住接线本身：主表的 map 必须迭代分页结果，且控件必须挂在同一组件内。
   */
  it('maps the page slice, not the whole set', async () => {
    const source = await readFile(new URL('../src/client/KnowledgeHome.tsx', import.meta.url), 'utf8')
    expect(source).toContain('docPageRows.rows.map(')
    // Rendering the unfiltered set is exactly the defect: the pager would move while the
    // table kept showing everything.
    expect(source).not.toMatch(/\{visible\.map\(/u)
  })

  it('keeps the page state in the component that renders the table', async () => {
    // 状态放在父组件、map 放在子组件，会得到 `Cannot find name 'pagedDocs'` 那类错误：
    // 页码和它裁剪出的行必须在同一个作用域里。
    const source = await readFile(new URL('../src/client/KnowledgeHome.tsx', import.meta.url), 'utf8')
    const homeStart = source.indexOf('export function KnowledgeHome(')
    expect(homeStart).toBeGreaterThan(0)
    const body = source.slice(homeStart)
    expect(body).toContain('const [docPage, setDocPage] = useState(1)')
    expect(body).toContain('paginate(visible, docPage, DEFAULT_PAGE_SIZE)')
  })

  it('draws the pager only past one page, and under the same tab guard as the table', async () => {
    const source = await readFile(new URL('../src/client/KnowledgeHome.tsx', import.meta.url), 'utf8')
    // `needsPager` 是"什么时候画"的唯一判据；`tab !== 'shared'` 让它只属于主表，
    // 共享表有自己的分页。
    expect(source).toMatch(/tab !== 'shared' && needsPager\(visible\.length, DEFAULT_PAGE_SIZE\)/u)
  })
})
