/**
 * 点「提取 Markdown」之后，界面必须立刻有反应，而且这个反应不能骗人。
 *
 * 用户报的是「点了没反应」：菜单项发请求、但面板只在该任务已经出现在 `extract.status`
 * 里时才轮询，所以点击那一刻它什么都不知道 —— 弹窗和角标都不动。
 *
 * 修法是**乐观条目**：点击即显示「排队中」并让角标 +1，等宿主报了这条任务再换成真实
 * 状态。这里钉住四件事：
 *   1. 乐观条目会计入待处理数（角标）；
 *   2. 宿主一报该路径，乐观条目立刻消失（不会出现两条）；
 *   3. 超过期限没被确认就撤掉（不能永久停在「排队中」）；
 *   4. 请求失败时给出**非空**原因（菜单以前把响应整个丢掉了）。
 */
import { describe, expect, it } from 'vitest'
import {
  OPTIMISTIC_TTL_MS,
  extractionFailureReason,
  mergeOptimistic,
  optimisticAlive,
  pendingCount,
  survivingOptimistic,
  tallyExtraction,
} from '../src/client/progressRules.ts'

/** One optimistic entry as the panel holds it. */
const entry = (relPath: string, requestedAt: number) => ({ relPath, requestedAt })

describe('a click shows up before the Host answers', () => {
  it('counts the queued guess in the badge', () => {
    // 角标 +1 就是"点击有反应"的可观察证据；不数它，读者看到的还是没变化。
    const reported: { relPath: string; state: string }[] = []
    const merged = mergeOptimistic(reported, [entry('a.pdf', 1_000)], 1_000)
    expect(merged.queued).toHaveLength(1)
    expect(pendingCount([], reported) + merged.queued.length).toBe(1)
  })

  it('draws the guess as a queued row alongside settled ones', () => {
    const reported = [{ relPath: 'old.pdf', state: 'succeeded' }]
    const merged = mergeOptimistic(reported, [entry('new.pdf', 1_000)], 1_100)
    expect(merged.rows.map(row => row.relPath)).toEqual(['old.pdf'])
    expect(merged.queued.map(queued => queued.relPath)).toEqual(['new.pdf'])
  })
})

describe('the Host\'s answer replaces the guess, never duplicates it', () => {
  it('drops the optimistic entry once the path is reported', () => {
    // 关键：一条任务只能有一行。猜的行和真的行同时画出来，读者会以为提交了两次。
    const reported = [{ relPath: 'a.pdf', state: 'pending' }]
    const merged = mergeOptimistic(reported, [entry('a.pdf', 1_000)], 1_200)
    expect(merged.queued).toEqual([])
    expect(merged.rows).toHaveLength(1)
  })

  it('drops it however the Host settled it', () => {
    // 成功、失败、不支持、已是 Markdown —— 只要宿主报了，猜就该退场。
    for (const state of ['succeeded', 'failed', 'unsupported', 'already-markdown', 'running']) {
      const merged = mergeOptimistic([{ relPath: 'a.pdf', state }], [entry('a.pdf', 0)], 10)
      expect(merged.queued, state).toEqual([])
    }
  })

  it('keeps an unrelated guess while another path is reported', () => {
    const reported = [{ relPath: 'a.pdf', state: 'running' }]
    const merged = mergeOptimistic(reported, [entry('b.pdf', 0)], 10)
    expect(merged.queued.map(queued => queued.relPath)).toEqual(['b.pdf'])
  })
})

describe('a guess never outlives its lifetime', () => {
  it('expires once the request has gone unconfirmed too long', () => {
    // 网络断掉时请求可能永远不会被宿主看见；永久停在「排队中」比不显示更糟。
    const pending = [entry('a.pdf', 1_000)]
    expect(optimisticAlive(pending[0]!, 1_000 + OPTIMISTIC_TTL_MS - 1)).toBe(true)
    expect(optimisticAlive(pending[0]!, 1_000 + OPTIMISTIC_TTL_MS)).toBe(false)
    expect(survivingOptimistic(pending, [], 1_000 + OPTIMISTIC_TTL_MS)).toEqual([])
  })

  it('expires even when the Host keeps reporting other documents', () => {
    // 宿主一直在报别的任务，不代表这一条被创建过。
    const pending = [entry('a.pdf', 0)]
    const reported = [{ relPath: 'other.pdf' }]
    expect(survivingOptimistic(pending, reported, OPTIMISTIC_TTL_MS + 1)).toEqual([])
  })

  it('lets a re-click extend the wait', () => {
    // 读者再点一次是新的请求，从那一刻重新计时；否则第二次点击会立刻被判超时。
    const first = entry('a.pdf', 0)
    const again = entry('a.pdf', OPTIMISTIC_TTL_MS - 1)
    expect(survivingOptimistic([again], [], OPTIMISTIC_TTL_MS + 1)).toHaveLength(1)
    expect(survivingOptimistic([first], [], OPTIMISTIC_TTL_MS + 1)).toEqual([])
  })
})

describe('a refusal says why, in words a reader can act on', () => {
  it('prefers the Host\'s own message', () => {
    expect(extractionFailureReason(403, { error: 'write access is required to extract here' }))
      .toBe('write access is required to extract here')
    expect(extractionFailureReason(500, { message: 'parser exploded' })).toBe('parser exploded')
  })

  it('never answers an empty reason', () => {
    // 截图里出现过「失败：」后面什么都没有——那比没有提示更糟。
    const cases: Array<[number, { error?: unknown; message?: unknown } | undefined]> = [
      [0, undefined], [400, undefined], [403, undefined], [404, undefined],
      [409, undefined], [500, undefined], [0, { error: '' }], [418, {}],
    ]
    for (const [status, body] of cases) {
      const reason = extractionFailureReason(status, body)
      expect(reason.trim(), String(status)).not.toBe('')
    }
  })

  it('separates the causes, because the next action differs', () => {
    // 断网要重试，无权限要去申请，文件不存在要去刷新——三件事不能都说成「失败」。
    expect(extractionFailureReason(0, undefined)).toMatch(/did not reach the server/u)
    expect(extractionFailureReason(403, undefined)).toMatch(/write access/u)
    expect(extractionFailureReason(404, undefined)).toMatch(/no longer exists/u)
  })

  it('reports the status code it actually saw', () => {
    // 让运维能把这条提示和网关日志对上。
    expect(extractionFailureReason(502, undefined)).toMatch(/502/u)
  })
})

describe('the tally counts the guess too', () => {
  it('keeps the drawn rows and the summary in agreement', () => {
    // 摘要的分母必须等于列表画出的行数，否则读者看到 0/1 却有两行。
    const reported = [{ relPath: 'done.pdf', state: 'succeeded' }]
    const merged = mergeOptimistic(reported, [entry('queued.pdf', 0)], 10)
    const total = merged.rows.length + merged.queued.length
    expect(total).toBe(2)
    const tally = tallyExtraction(merged.rows)
    // 一行已终结、一行排队中：分子 1 = 已终结，分母 2 = 画出的行数。
    expect(tally.done + tally.failed).toBe(1)
    expect(tally.total).toBe(1)
  })
})
