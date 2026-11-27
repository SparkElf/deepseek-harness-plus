/**
 * 截面因子评估测试 —— 手工基准 + 上游 bug 回归。
 *
 * 关键回归：上游 factorEvaluate 的「摊平截面」用法会把 factor[i] 与
 * forwardReturns[i+1] 错位配对。本测试用一个人造截面证明：
 * 正确口径（逐时点横截面相关）与摊平口径给出不同结果，且前者等于手算值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { factorEvaluateCrossSection } from '../src/dsh-alpha/cross-section.js'
import { factorEvaluate } from '../src/dsh-alpha/factor.js'

/** 手算 Pearson（用于基准）。 */
function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length
  const ma = a.reduce((x, y) => x + y, 0) / n
  const mb = b.reduce((x, y) => x + y, 0) / n
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < n; i++) {
    cov += (a[i]! - ma) * (b[i]! - mb)
    va += (a[i]! - ma) ** 2
    vb += (b[i]! - mb) ** 2
  }
  return cov / Math.sqrt(va * vb)
}

test('cross-section: 完美正向因子 → IC = 1', () => {
  // 3 个时点 × 5 个资产，因子与未来收益完全同序
  const factor = [
    [1, 2, 3, 4, 5],
    [2, 4, 6, 8, 10],
    [5, 4, 3, 2, 1],
  ]
  const rets = [
    [0.01, 0.02, 0.03, 0.04, 0.05],
    [0.02, 0.04, 0.06, 0.08, 0.10],
    [0.05, 0.04, 0.03, 0.02, 0.01],
  ]
  const out = factorEvaluateCrossSection(factor, rets, 5)
  assert.equal(out.periods, 3)
  for (const p of out.series) assert.ok(Math.abs(p.ic - 1) < 1e-12, `period ${p.period} ic=${p.ic}`)
  assert.ok(Math.abs(out.meanIc - 1) < 1e-12)
  assert.equal(out.icPositiveRate, 100)
})

test('cross-section: 手算基准逐时点吻合', () => {
  const factor = [
    [3, 1, 4, 1, 5, 9],
    [2, 7, 1, 8, 2, 8],
  ]
  const rets = [
    [0.02, -0.01, 0.03, 0.0, 0.05, 0.11],
    [-0.02, 0.07, -0.01, 0.08, 0.02, 0.08],
  ]
  const out = factorEvaluateCrossSection(factor, rets, 2)
  const expected = pearson(factor[0]!, rets[0]!)
  assert.ok(Math.abs(out.series[0]!.ic - expected) < 1e-12, `got ${out.series[0]!.ic} want ${expected}`)
})

test('cross-section: 缺失值用 null 跳过，样本不足的时点被丢弃', () => {
  const factor = [
    [1, 2, null, 4, 5],   // 4 个有效
    [1, null, null, null, null], // 1 个有效 — 低于 minAssets
  ]
  const rets = [
    [0.1, 0.2, 0.3, 0.4, 0.5],
    [0.1, 0.2, 0.3, 0.4, 0.5],
  ]
  const out = factorEvaluateCrossSection(factor, rets, 5)
  assert.equal(out.periods, 0, '两个时点都不足 5 个资产')
  const out2 = factorEvaluateCrossSection(factor, rets, 4)
  assert.equal(out2.periods, 1)
  assert.equal(out2.series[0]!.assets, 4)
})

test('cross-section: ICIR / t 值 = 0 当 IC 无波动', () => {
  const factor = [[1, 2, 3, 4, 5], [2, 4, 6, 8, 10]]
  const rets = [[0.1, 0.2, 0.3, 0.4, 0.5], [0.2, 0.4, 0.6, 0.8, 1.0]]
  const out = factorEvaluateCrossSection(factor, rets, 5)
  assert.equal(out.icStd, 0)
  assert.equal(out.icir, 0)
  assert.equal(out.icTStat, 0)
})

test('cross-section: minAssets 参数校验', () => {
  assert.throws(() => factorEvaluateCrossSection([], [], 1), /minAssets/)
  assert.throws(() => factorEvaluateCrossSection([], [], 2.5), /minAssets/)
})

test('REGRESSION: 上游摊平口径在截面上给出错误结果', () => {
  // 构造一个截面：因子与收益在所有时点都强正相关
  const periods = 4
  const assets = 6
  const factor: number[][] = []
  const rets: number[][] = []
  for (let t = 0; t < periods; t++) {
    const fRow: number[] = []
    const rRow: number[] = []
    for (let a = 0; a < assets; a++) {
      const v = a + 1 + t * 0.1
      fRow.push(v)
      rRow.push(v * 0.001 + (t % 2 === 0 ? 0.0001 : -0.0001))
    }
    factor.push(fRow)
    rets.push(rRow)
  }
  const correct = factorEvaluateCrossSection(factor, rets, 5)
  assert.ok(correct.meanIc > 0.99, `correct meanIc should be ~1, got ${correct.meanIc}`)

  // 上游用法：摊平为两条一维序列
  const flatF = factor.flat()
  const flatR = rets.flat()
  const upstream = factorEvaluate(flatF, flatR)
  // 上游 lagPair 会错位，结果与正确值显著不同
  assert.ok(
    Math.abs(upstream.ic - correct.meanIc) > 0.01,
    `upstream flattened IC (${upstream.ic}) should differ from correct cross-sectional IC (${correct.meanIc})`,
  )
})
