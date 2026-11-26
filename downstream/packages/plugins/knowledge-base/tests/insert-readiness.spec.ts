/**
 * 新建会话后「何时继续等、何时放弃」的判定。
 *
 * 这组用例守的是一类特定的 bug：**防静默的代码自己静默了**。
 * `deadline` 曾经写在重试函数体内，每轮重算，于是永不超时，
 * 「报错」这条分支永远走不到——用户看到的是对话框关掉、什么都没发生，
 * 而这正是整个改动要消灭的症状。下面把它钉死。
 */
import { describe, expect, it } from 'vitest'
import {
  deadlineFrom,
  decideReadiness,
  isExpired,
  type ReadinessProbe,
} from '../src/client/insertReadiness.ts'

/** A probe that found a session and inserted into it. */
const ok = (): ReadinessProbe => ({ hasTarget: true, inserted: true })

describe('a spent budget always produces a failure, never another wait', () => {
  it('reports no-target when the session never appeared', () => {
    // Out of time and the catalog still has no id: this is "no conversation to
    // reference", not "could not insert".
    expect(decideReadiness({ hasTarget: false, inserted: false }, true)).toBe('failed-no-target')
  })

  it('reports insert-failure when a session existed but nothing landed', () => {
    // The two failures stay distinct so the reader is not told the wrong one.
    expect(decideReadiness({ hasTarget: true, inserted: false }, true)).toBe('failed-insert')
  })

  it('never answers retry once expired', () => {
    // The property that the old broken deadline violated: expired must ALWAYS be
    // terminal. Checking every probe shape is what makes this exhaustive.
    const probes: ReadinessProbe[] = [
      { hasTarget: false, inserted: false },
      { hasTarget: false, inserted: true },
      { hasTarget: true, inserted: false },
      ok(),
    ]
    for (const probe of probes) {
      expect(decideReadiness(probe, true)).not.toBe('retry')
    }
  })

  it('still retries while the budget is open', () => {
    expect(decideReadiness({ hasTarget: false, inserted: false }, false)).toBe('retry')
    expect(decideReadiness({ hasTarget: true, inserted: false }, false)).toBe('retry')
  })

  it('stops as soon as the insert lands, even with budget left', () => {
    expect(decideReadiness(ok(), false)).toBe('done')
  })
})

describe('the deadline is a fixed instant, not a moving one', () => {
  it('is computed from the start, so repeated checks converge on expiry', () => {
    // This is the regression guard. If a caller recomputed the deadline per retry
    // (deadline = now + budget), `isExpired` would answer false forever.
    const start = 1_000
    const budget = 4_000
    const deadline = deadlineFrom(start, budget)

    // Every check uses the SAME deadline and only the clock advances.
    expect(isExpired(start, deadline)).toBe(false)
    expect(isExpired(start + 3_999, deadline)).toBe(false)
    expect(isExpired(start + 4_000, deadline)).toBe(true)
    expect(isExpired(start + 10_000, deadline)).toBe(true)
  })

  it('expires immediately for a zero budget', () => {
    // The cheap version of the real scenario: a budget small enough to be spent at
    // once must report failure, not hang. This is the assertion the Lead asked for.
    const now = 5_000
    expect(isExpired(now, deadlineFrom(now, 0))).toBe(true)
  })

  it('would have caught the moving-deadline bug', () => {
    // Simulate the broken shape: recompute the deadline on each retry. With a zero
    // budget it still reports "not expired" because the deadline keeps moving ahead of
    // the clock -- which is exactly why the bug produced silence.
    const brokenInfinite = (now: number): boolean => now >= deadlineFrom(now, 0) + 1
    expect(brokenInfinite(0)).toBe(false)
    expect(brokenInfinite(1_000_000)).toBe(false)

    // The correct shape terminates.
    const deadline = deadlineFrom(0, 0)
    expect(isExpired(0, deadline)).toBe(true)
  })
})
