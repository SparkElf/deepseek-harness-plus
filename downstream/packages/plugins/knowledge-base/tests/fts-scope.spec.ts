// @ts-nocheck
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { searchIndex, syncIndex, trigramWindows } from '../src/ftsIndex.ts'

/**
 * 检索范围与中文分词的回归用例（task-17）。
 *
 * 背景：
 * - `searchIndexUnlocked` 在 `caller.global === true` 时只查 `d.scope='global'`，
 *   管理员搜不到自己 Personal 里的文档；
 * - trigram FTS 对两字词（立项/招标）不成 token，对没有空格的长中文整句也匹配不上，
 *   两者叠加就是「个人空间的文档怎么都搜不到」。
 */

const writeDoc = async (root: string, relPath: string, text: string) => {
  const absolute = join(root, relPath)
  await mkdir(join(absolute, '..'), { recursive: true })
  await writeFile(absolute, text, 'utf8')
}

const buildFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-fts-scope-'))
  const indexPath = join(root, '.index', 'kb-index.sqlite')
  const actualRoot = join(root, 'actual')
  await mkdir(actualRoot, { recursive: true })
  await writeDoc(actualRoot, 'global/制度/投资管理.md', '# 投资管理\n\n集团投资项目立项需经董事会审议，招标由采购中心组织。\n')
  await writeDoc(actualRoot, 'personal/admin/我的笔记.md', '# 我的笔记\n\n加油站项目立项流程：先做可研，再报投资部审批。\n')
  await writeDoc(actualRoot, 'personal/other-user/别人的笔记.md', '# 别人的笔记\n\n别人的加油站立项笔记，管理员不该搜到。\n')
  await syncIndex({ actualRoot, indexPath })
  return { root, indexPath, actualRoot }
}

const admin = { callerId: 'admin', departmentCodes: [], global: true }
const canRead = async () => true

const search = (indexPath: string, query: string, caller = admin) =>
  searchIndex({ indexPath, query, topK: 10, caller, canRead })

describe('knowledge-base search scope', () => {
  it('lets a global admin hit their own personal document', async () => {
    const { root, indexPath } = await buildFixture()
    try {
      const result = await search(indexPath, '加油站')
      const paths = result.hits.map(hit => hit.path)
      expect(paths).toContain('personal/admin/我的笔记.md')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never returns another user\u2019s personal document to a global admin', async () => {
    const { root, indexPath } = await buildFixture()
    try {
      // 「别人的笔记」只出现在 other-user 的文档里。trigram 会顺带命中自己文档里的
      // 「的笔记」窗口（同一批字符），所以不要求结果为空，只要求别人的文档不出现。
      const result = await search(indexPath, '别人的笔记')
      const paths = result.hits.map(hit => hit.path)
      expect(paths).not.toContain('personal/other-user/别人的笔记.md')
      for (const path of paths) expect(path.startsWith('personal/other-user/')).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still returns global documents to a global admin', async () => {
    const { root, indexPath } = await buildFixture()
    try {
      const result = await search(indexPath, '董事会')
      expect(result.hits.map(hit => hit.path)).toContain('global/制度/投资管理.md')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finds a two-character term through the LIKE fallback', async () => {
    const { root, indexPath } = await buildFixture()
    try {
      const result = await search(indexPath, '立项')
      const paths = result.hits.map(hit => hit.path)
      expect(paths).toContain('personal/admin/我的笔记.md')
      expect(paths).toContain('global/制度/投资管理.md')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finds a long Chinese question without spaces by trigram windows', async () => {
    const { root, indexPath } = await buildFixture()
    try {
      const result = await search(indexPath, '投资一个加油站立项流程是怎样的')
      expect(result.hits.map(hit => hit.path)).toContain('personal/admin/我的笔记.md')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('builds trigram windows only for runs of at least three characters', () => {
    expect(trigramWindows('立项')).toEqual([])
    expect(trigramWindows('加油站')).toEqual(['加油站'])
    expect(trigramWindows('投资一个加油站立项流程')).toContain('加油站')
  })

  it('caps the number of windows so one query cannot fan out unbounded', () => {
    // 只有整句 0 命中时才会展开，且展开数量有上限：这里断言「再长也只跑 12 次」
    // 注意用「不同字」构造：窗口是先按 trigram 去重的，'投'.repeat(200) 只会产出 1 个窗口
    const long = '投资一个加油站立项审批流程'.repeat(20)
    expect(trigramWindows(long)).toHaveLength(12)
    expect(trigramWindows('投资一个加油站立项流程').length).toBeLessThanOrEqual(12)
  })
})
