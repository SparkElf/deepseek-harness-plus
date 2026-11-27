/**
 * A 股策略回测引擎（纯函数、零依赖）—— dsh-strategy 域。
 *
 * 来源：本模块从 A 股策略研究台（/root/projects/a-share-strategy-lab）的实验代码
 * 移植而来，去掉实验脚手架、补齐类型与契约，使其成为可复用的库函数。
 *
 * 与上游 dsh-quant 的 backtest 域的区别（这是本 fork 的核心增量）：
 * - 上游：单标的、全仓进出、固定 feeRate、无杠杆护栏
 * - 本模块：**多标的组合**、**目标权重**语义、A 股真实成本拆分、
 *   **总权重硬护栏（防止隐性杠杆）**、逐 bar 开盘价成交（无未来函数）
 *
 * 契约：
 * - 信号在 bar i 收盘后给出目标权重，在 bar i+1 的**开盘价**成交
 * - 权重向量 targetWeight[i][k] ∈ [0,1]，引擎强制 Σw ≤ 1（超出则等比归一）
 * - 所有函数为纯函数，无共享状态，可并发调用
 */

// ───────────────────────── A 股真实成本模型 ─────────────────────────

/** A 股交易成本参数（单边，按成交额比例；默认值为常见散户费率）。 */
export interface CostModel {
  /** 佣金率（双边收取） */
  commission: number
  /** 印花税率（仅卖出收取） */
  stampDuty: number
  /** 过户费率（双边收取） */
  transferFee: number
  /** 滑点率（按成交价比例，双边） */
  slippage: number
}

/** 默认成本模型：佣金万 2.5、印花税千 0.5、过户费十万分之一、滑点万 5。 */
export const DEFAULT_COST: CostModel = {
  commission: 0.00025,
  stampDuty: 0.0005,
  transferFee: 0.00001,
  slippage: 0.0005,
}

/** 计算买入单边成本率。 */
export function buyCostRate(cost: CostModel = DEFAULT_COST): number {
  return cost.commission + cost.transferFee + cost.slippage
}

/** 计算卖出单边成本率（含印花税）。 */
export function sellCostRate(cost: CostModel = DEFAULT_COST): number {
  return cost.commission + cost.stampDuty + cost.transferFee + cost.slippage
}

// ───────────────────────── 基础序列工具 ─────────────────────────

/** 单根 K 线（与 dsh-quant 的 candle 结构兼容，另接受 close/open 等短名）。 */
export interface Bar {
  /** 时间戳（毫秒） */
  t?: number
  /** 开盘价 */
  o?: number
  /** 最高价 */
  h?: number
  /** 最低价 */
  l?: number
  /** 收盘价（必需） */
  c: number
  /** 成交量 */
  v?: number
  /** 兼容别名：open */
  open?: number
  /** 兼容别名：close */
  close?: number
}

/** 读取收盘价（兼容 c / close 两种字段名）。 */
export function barClose(b: Bar): number {
  return b.c ?? b.close ?? 0
}

/** 读取开盘价（兼容 o / open；缺失时退回收盘价）。 */
export function barOpen(b: Bar): number {
  const v = b.o ?? b.open
  return v === undefined || v <= 0 ? barClose(b) : v
}

/**
 * 简单移动平均。返回与输入等长，前 window-1 位为 null。
 * @param values 数值序列
 * @param window 窗口（>= 1）
 */
export function sma(values: readonly number[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (!Number.isInteger(window) || window < 1 || values.length < window) return out
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!
    if (i >= window) sum -= values[i - window]!
    if (i >= window - 1) out[i] = sum / window
  }
  return out
}

/** 滚动总体标准差。返回与输入等长，前 window-1 位为 null。 */
export function rollingStd(values: readonly number[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (!Number.isInteger(window) || window < 1) return out
  for (let i = window - 1; i < values.length; i++) {
    let mean = 0
    for (let j = i - window + 1; j <= i; j++) mean += values[j]!
    mean /= window
    let v = 0
    for (let j = i - window + 1; j <= i; j++) v += (values[j]! - mean) ** 2
    out[i] = Math.sqrt(v / window)
  }
  return out
}

/** 逐期简单收益率（等长，首位 0）。 */
export function simpleReturns(close: readonly number[]): number[] {
  const r = new Array<number>(close.length).fill(0)
  for (let i = 1; i < close.length; i++) {
    const prev = close[i - 1]!
    r[i] = prev > 0 ? close[i]! / prev - 1 : 0
  }
  return r
}

// ───────────────────────── 组合回测核心 ─────────────────────────

/** 回测选项。 */
export interface BacktestOptions {
  /** 年化期数（每年 bar 数）。默认 243（A 股交易日）；加密 7×24 用 365。 */
  barsPerYear?: number
  /** 成本模型。 */
  cost?: CostModel
  /**
   * 单 bar 总权重上限（硬护栏）。
   * 信号给出的 Σw 超过该值时按比例归一 —— 这防止「对每只标的独立给满仓」
   * 造成的隐性杠杆（实测该 bug 会把 Calmar 从 0.13 虚增到 132）。
   */
  grossCap?: number
}

/** 回测结果。 */
export interface BacktestResult {
  /** 等长净值曲线（初始 1） */
  equity: number[]
  /** 逐期收益（等长，首位 0） */
  returns: number[]
  /** 区间总收益率 % */
  totalReturnPct: number
  /** 最大回撤 % */
  maxDrawdownPct: number
  /** 年化夏普（按 barsPerYear 年化） */
  sharpe: number
  /** 年化收益率 % */
  annualReturnPct: number
  /** Calmar = 年化收益 / 最大回撤 */
  calmar: number
  /** 平均单期换手率（占组合权益比例） */
  avgTurnover: number
  /** bar 数 */
  bars: number
  /** 归一前信号的最大总权重（> grossCap 表示策略曾超配） */
  maxGrossRaw: number
  /** 累计交易成本（占初始权益比例） */
  totalCostRatio: number
}

/**
 * 目标权重组合回测：每根 bar 给出目标权重，下一根开盘成交。
 *
 * @param bars    每个标的的 K 线序列（等长）
 * @param signals targetWeight[i][k] = bar i 收盘后对标的 k 的目标权重
 * @param options 年化期数、成本模型、总权重上限
 * @returns 净值曲线与绩效指标
 *
 * @example
 * ```ts
 * // 等权持有两只标的
 * const w = bars.length === 2 ? [0.5, 0.5] : []
 * const signals = bars[0].map(() => w)
 * const r = backtestTargetWeights(bars, signals)
 * ```
 */
export function backtestTargetWeights(
  bars: readonly (readonly Bar[])[],
  signals: readonly (readonly number[])[],
  options: BacktestOptions = {},
): BacktestResult {
  const barsPerYear = options.barsPerYear ?? 243
  const cost = options.cost ?? DEFAULT_COST
  const grossCap = options.grossCap ?? 1
  if (!bars.length) throw new RangeError('bars must contain at least one instrument')
  const n = bars[0].length
  const K = bars.length
  if (n === 0) throw new RangeError('bars must contain at least one bar')
  for (const s of bars) {
    if (s.length !== n) throw new RangeError('all instruments must have the same number of bars')
  }
  const buyRate = buyCostRate(cost)
  const sellRate = sellCostRate(cost)

  // ── 总权重护栏：按 grossCap 等比归一，并记录原始最大值 ──
  let maxGrossRaw = 0
  const normSignals: (readonly number[])[] = signals.map(row => {
    if (!row) return []
    let sum = 0
    for (const w of row) if (w > 0) sum += w
    if (sum > maxGrossRaw) maxGrossRaw = sum
    if (sum > grossCap && sum > 0) {
      const scale = grossCap / sum
      return row.map(w => (w > 0 ? w * scale : 0))
    }
    return row
  })

  let cash = 1
  const positions = new Array<number>(K).fill(0)
  const equity = new Array<number>(n).fill(1)
  const turnoverLog: number[] = []
  let totalCost = 0

  for (let i = 0; i < n; i++) {
    // 1) 用本 bar 开盘价执行「上一根 bar 收盘确认」的目标权重
    const target = i > 0 ? normSignals[i - 1] : undefined
    if (target && target.length) {
      let posValue = 0
      for (let k = 0; k < K; k++) posValue += positions[k]! * barOpen(bars[k]![i]!)
      const total = cash + posValue
      if (total > 0) {
        let turnover = 0
        for (let k = 0; k < K; k++) {
          const want = Math.max(0, Math.min(1, target[k] ?? 0)) * total
          const price = barOpen(bars[k]![i]!)
          if (price <= 0) continue
          const cur = positions[k]! * price
          const delta = want - cur
          if (Math.abs(delta) < 1e-12) continue
          if (delta > 0) {
            const shares = delta / price
            const fee = delta * buyRate
            if (delta + fee > cash) continue // 现金不足则跳过该笔
            positions[k]! += shares
            cash -= delta + fee
            totalCost += fee
          } else {
            const shares = Math.min(positions[k]!, -delta / price)
            const proceeds = shares * price
            const fee = proceeds * sellRate
            positions[k]! -= shares
            cash += proceeds - fee
            totalCost += fee
          }
          turnover += Math.abs(delta) / total
        }
        if (turnover > 0) turnoverLog.push(turnover)
      }
    }
    // 2) 用本 bar 收盘价盯市
    let posValue = 0
    for (let k = 0; k < K; k++) posValue += positions[k]! * barClose(bars[k]![i]!)
    equity[i] = cash + posValue
  }

  const rets = simpleReturns(equity)
  const maxDd = maxDrawdown(equity)
  const totalReturn = equity[n - 1]! / equity[0]! - 1
  const annReturn = annualizedReturn(equity, barsPerYear)
  return {
    equity,
    returns: rets,
    totalReturnPct: totalReturn * 100,
    maxDrawdownPct: maxDd * 100,
    sharpe: sharpeRatio(rets, barsPerYear),
    annualReturnPct: annReturn * 100,
    calmar: maxDd === 0 ? 0 : annReturn / maxDd,
    avgTurnover: turnoverLog.length ? turnoverLog.reduce((a, b) => a + b, 0) / turnoverLog.length : 0,
    bars: n,
    maxGrossRaw,
    totalCostRatio: totalCost,
  }
}

/** 单标的便捷回测：close 序列 + 目标仓位序列（0..1）。 */
export function backtestSingle(
  barSeries: readonly Bar[],
  targetWeights: readonly number[],
  options: BacktestOptions = {},
): BacktestResult {
  return backtestTargetWeights([barSeries], targetWeights.map(w => [w]), options)
}

// ───────────────────────── 绩效指标 ─────────────────────────

/** 最大回撤（返回正比例，如 0.15 表示 15%）。 */
export function maxDrawdown(equity: readonly number[]): number {
  let peak = equity[0] ?? 1
  let mdd = 0
  for (const v of equity) {
    if (v > peak) peak = v
    const dd = peak > 0 ? (peak - v) / peak : 0
    if (dd > mdd) mdd = dd
  }
  return mdd
}

/** 年化收益率（小数）。 */
export function annualizedReturn(equity: readonly number[], barsPerYear: number): number {
  const n = equity.length
  if (n < 2 || equity[0]! <= 0) return 0
  return Math.pow(equity[n - 1]! / equity[0]!, barsPerYear / (n - 1)) - 1
}

/**
 * 年化夏普比率（无风险利率按 0）。
 * @param returns 逐期收益
 * @param barsPerYear 年化期数（A 股 243，加密 365）
 */
export function sharpeRatio(returns: readonly number[], barsPerYear = 243): number {
  const r = returns.slice(1)
  if (r.length < 2) return 0
  const mean = r.reduce((a, b) => a + b, 0) / r.length
  const sd = Math.sqrt(r.reduce((a, x) => a + (x - mean) ** 2, 0) / r.length)
  return sd === 0 ? 0 : (mean / sd) * Math.sqrt(barsPerYear)
}

/** 下行波动率（年化，只统计负收益期）。 */
export function downsideDeviation(returns: readonly number[], barsPerYear = 243): number {
  const r = returns.slice(1).filter(x => x < 0)
  if (!r.length) return 0
  const v = r.reduce((a, x) => a + x * x, 0) / r.length
  return Math.sqrt(v) * Math.sqrt(barsPerYear)
}

/**
 * 等权买入持有基准：对传入的全部标的各分配 1/K 权重并全程持有。
 *
 * 用途：任何策略回测都必须有基准对照 —— 在单边下跌市里，
 * "策略亏 3% 而基准亏 10%" 与 "策略赚 3% 而基准赚 10%" 是相反的结论。
 *
 * @param bars 标的多序列
 * @param options 年化期数与成本模型
 * @returns 与 backtestTargetWeights 同结构的回测结果
 */
export function equalWeightBenchmark(
  bars: readonly (readonly Bar[])[],
  options: BacktestOptions = {},
): BacktestResult {
  if (!bars.length) throw new RangeError('bars must contain at least one instrument')
  const n = bars[0]!.length
  const w = 1 / bars.length
  const signals = Array.from({ length: n }, () => bars.map(() => w))
  return backtestTargetWeights(bars, signals, options)
}
