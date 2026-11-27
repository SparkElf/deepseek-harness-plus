/**
 * 日频检验（Daily-frequency testing with Newey-West）—— dsh-strategy 域。
 *
 * 动机：用「15 个不重叠 63 天窗口」做检验浪费了大量数据 —— 每个窗口内部的
 * 每日信息被压缩成一个数字。金融计量学的标准做法是：
 *   对策略的**每日超额收益**做均值检验，用 Newey-West 校正自相关。
 * 这样用满 1000 个交易日的信息，而不是 15 个窗口。
 *
 * ⚠️ 重要诚实说明：这**不能**凭空创造信息。
 * 有效独立样本量仍受数据长度限制（约 T/窗口长度）。本模块的价值是：
 *   1. 使用全部数据，得到更稳的均值与方差估计
 *   2. Newey-West 用**自适应滞后**（默认 1.5×窗口），正确反映自相关
 *   3. 显式报告**有效样本量 (effectiveN)**，避免用 n=1000 虚报自由度
 */
import { meanSeNW, power } from './stats.js'

/** 日频检验结果。 */
export interface DailyTestResult {
  /** 交易日数 */
  n: number
  /** 每日超额收益均值（小数，如 0.0016 = 0.16%/日） */
  meanDaily: number
  /** 日均值的 Newey-West 标准误 */
  seDaily: number
  /** Newey-West 校正后的 t 值 */
  tStat: number
  /** 双尾 p 值（正态近似） */
  pValue: number
  /** 年化超额收益（按 annualization 期/年） */
  annualizedExcessPct: number
  /** 使用的 Newey-West 滞后阶数 */
  lags: number
  /**
   * 有效独立样本量 = n / (1 + 2·Σ(1-l/(L+1))·ρ_l)。
   * 这是**诚实自由度**：不能拿 n=1000 当 1000 个独立样本。
   */
  effectiveN: number
  /** 基于有效样本量的功效 */
  power: number
}

/** 逐期收益工具。 */
function toReturns(equity: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]!
    out.push(prev > 0 ? equity[i]! / prev - 1 : 0)
  }
  return out
}

/** 逐期自相关（滞后 l）。 */
export function autocorr(xs: readonly number[], lag: number): number {
  const n = xs.length
  if (n <= lag + 1) return 0
  const mean = xs.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) den += (xs[i]! - mean) ** 2
  for (let i = lag; i < n; i++) num += (xs[i]! - mean) * (xs[i - lag]! - mean)
  return den === 0 ? 0 : num / den
}

/**
 * 对每日超额收益做 Newey-West 均值检验。
 *
 * @param strategyEquity  策略净值曲线（初始 1）
 * @param benchmarkEquity 基准净值曲线（初始 1，等长）
 * @param options.lags           Newey-West 滞后阶数；缺省自动取 max(1, round(1.5×windowLen))
 * @param options.windowLen      策略的持仓窗口长度（用于自动选滞后阶）
 * @param options.annualization  年化期数（A 股 243）
 * @returns 日频检验结果（含有效样本量）
 */
export function dailyExcessTest(
  strategyEquity: readonly number[],
  benchmarkEquity: readonly number[],
  options: { lags?: number; windowLen?: number; annualization?: number } = {},
): DailyTestResult {
  const annualization = options.annualization ?? 243
  const windowLen = options.windowLen ?? 63
  // 自动滞后阶：窗口长度决定自相关跨度。1.5×窗口是常见经验值（覆盖大部分依赖）。
  const lags = options.lags ?? Math.max(1, Math.round(1.5 * windowLen))
  const n = Math.min(strategyEquity.length, benchmarkEquity.length)
  if (n < 3) {
    return {
      n, meanDaily: 0, seDaily: Infinity, tStat: 0, pValue: 1,
      annualizedExcessPct: 0, lags, effectiveN: 0, power: 0,
    }
  }
  const sr = toReturns(strategyEquity.slice(0, n))
  const br = toReturns(benchmarkEquity.slice(0, n))
  const excess = sr.map((x, i) => x - br[i]!)

  const { mean, se, t } = meanSeNW(excess, lags)
  // 双尾 p（正态近似）
  const p = 2 * (1 - normalCdf(Math.abs(t)))
  // 有效样本量：用自相关和估计的方差膨胀因子。
  // ⚠️ 修正记录：早期版本直接 vif = 1 + 2Σw·ρ_l，当存在**负自相关**时
  // vif 会小于 1（实测 0.775），导致 effectiveN = n/vif = 1288 > n = 999 ——
  // 数学上不可能（有效样本量不能超过实际观测数）。
  // 正确做法：VIF 下限为 1（负自相关只会**提高**而非降低有效样本量，
  // 但那是收益，不是我们把 n 放大到超过实际样本数的理由）。
  let vifRaw = 1
  for (let l = 1; l <= lags; l++) {
    vifRaw += 2 * (1 - l / (lags + 1)) * autocorr(excess, l)
  }
  const vif = Math.max(1, vifRaw)
  const effectiveN = Math.max(1, Math.min(excess.length, excess.length / vif))
  const sdDaily = se * Math.sqrt(excess.length)   // 由 se 反推单期标准差
  const powerNow = effectiveN >= 2 && sdDaily > 0
    ? power(Math.abs(mean), sdDaily, effectiveN)
    : 0

  return {
    n: excess.length,
    meanDaily: mean,
    seDaily: se,
    tStat: t,
    pValue: p,
    annualizedExcessPct: mean * annualization * 100,
    lags,
    effectiveN,
    power: powerNow,
  }
}

/** 标准正态 CDF（避免跨模块依赖细节）。 */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const cdf = 1 - Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * poly
  return x >= 0 ? cdf : 1 - cdf
}
