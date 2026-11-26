/**
 * 提取失败必须进入「进度」面板，而不是变成侧栏底部的一行常驻错误。
 *
 * 用户报的是两件事同时发生：侧栏底部出现「提取失败：… — no such file」，而进度面板却
 * 显示"当前没有正在上传或提取的文件"。原因是 `extract.retry` 在真正入队之前就用 404
 * 拒绝了请求，宿主的 `extract.status` 永远看不到这条失败；页面只把它写进了 `batchError`。
 *
 * 这里钉住修复后的四条规则：
 *   1. `no such file` 这类底层原因被归类为"源文件不存在"，界面据此给出可读文案；
 *   2. 其他原因原样保留，不编造友好措辞掩盖细节；
 *   3. 宿主一旦报告了同一路径（例如重试入队），客户端记录不再重复显示；
 *   4. 会话级失败记录在组件之外存活，且同路径重复失败只保留最新一条。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  classifyExtractionFailure,
  survivingClientFailures,
  type FailedExtractionView,
} from '../src/client/progressRules.ts'
import {
  SESSION_FAILURE_LIMIT,
  clearExtractionFailures,
  forgetExtractionFailure,
  readExtractionFailures,
  rememberExtractionFailure,
} from '../src/client/extractionHistory.ts'

const failure = (relPath: string, reason: string, at = 1_000): FailedExtractionView => ({ relPath, reason, at })

beforeEach(() => { clearExtractionFailures() })

describe('a failed extraction has a readable reason', () => {
  it('recognises the Host’s no-such-file answer', () => {
    expect(classifyExtractionFailure('no such file')).toBe('missing-file')
    expect(classifyExtractionFailure('ENOENT: no such file or directory, stat ...')).toBe('missing-file')
  })

  it('leaves every other reason alone', () => {
    expect(classifyExtractionFailure('write access is required to extract here')).toBe('other')
    expect(classifyExtractionFailure('the extractor failed without reporting a reason')).toBe('other')
  })
})

describe('the panel draws the failures the Host has no task for', () => {
  it('keeps a failure the Host never reports', () => {
    const rows = survivingClientFailures([], [failure('personal/u/a.pdf', 'no such file')], [])
    expect(rows.map(row => row.relPath)).toEqual(['personal/u/a.pdf'])
  })

  it('drops the record once the Host reports the same path', () => {
    const reported = [{ relPath: 'personal/u/a.pdf', state: 'succeeded' }]
    expect(survivingClientFailures(reported, [failure('personal/u/a.pdf', 'no such file')], [])).toEqual([])
  })

  it('drops the record while a newer request for the same path is queued', () => {
    const queued = [{ relPath: 'global/a.pdf' }]
    expect(survivingClientFailures([], [failure('global/a.pdf', 'no such file')], queued)).toEqual([])
  })
})

describe('the session remembers failures across a navigation', () => {
  it('reads back what it recorded', () => {
    rememberExtractionFailure({ relPath: 'global/a.pdf', reason: 'no such file', at: 5 })
    expect(readExtractionFailures()).toEqual([failure('global/a.pdf', 'no such file', 5)])
  })

  it('replaces a repeated path instead of stacking rows', () => {
    rememberExtractionFailure({ relPath: 'global/a.pdf', reason: 'first', at: 5 })
    rememberExtractionFailure({ relPath: 'global/a.pdf', reason: 'second', at: 6 })
    expect(readExtractionFailures()).toEqual([failure('global/a.pdf', 'second', 6)])
  })

  it('forgets a path once a retry is accepted', () => {
    rememberExtractionFailure({ relPath: 'global/a.pdf', reason: 'no such file' })
    forgetExtractionFailure('global/a.pdf')
    expect(readExtractionFailures()).toEqual([])
  })

  it('caps the session at its documented limit', () => {
    for (let index = 0; index < SESSION_FAILURE_LIMIT + 5; index += 1) {
      rememberExtractionFailure({ relPath: 'global/' + String(index) + '.pdf', reason: 'no such file', at: index })
    }
    const rows = readExtractionFailures()
    expect(rows).toHaveLength(SESSION_FAILURE_LIMIT)
    // The oldest were evicted; the newest is still there.
    expect(rows[rows.length - 1]?.relPath).toBe('global/' + String(SESSION_FAILURE_LIMIT + 4) + '.pdf')
  })
})
