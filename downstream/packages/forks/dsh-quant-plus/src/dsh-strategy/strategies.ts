/**
 * A 股策略库（纯函数、零依赖）—— dsh-strategy 域。
 *
 * 所有策略遵循统一契约：
 * - `generate(bars, ctx)` 返回 targetWeight[i][k]（bar i 收盘后的目标权重）
 * - 只看 bar i 及之前的数据（无未来函数）
 * - 权重和 ≤ 1（引擎另有硬护栏兜底）
 *
 * 这些策略经 A 股 CSI300 样本（2023-11~2026-09，11 个不重叠 63 日窗口）
 * 实证评估，其中：
 * - `momentumStop`（动量+趋势闸门+个股止损）：前向验证超额中位 +11.33%、跑赢 67%
 * - `lowVolCircuit`（低波+熔断）：回撤小但前向验证超额不显著（-3.81%），已标注
 * 详见项目 FORK.md 与 STATE.md。
 */
import { type Bar, barClose, sma, rollingStd, simpleReturns, backtestTargetWeights } from './engine.js'

/** 策略上下文参数（各策略按需读取，未用到的忽略）。 */
export interface StrategyContext {
  [key: string]: number | boolean | undefined
}

/** 策略定义。 */
export interface Strategy {
  /** 稳定标识（用于报告与参数覆盖） */
  id: string
  /** 人类可读名称 */
  name: string
  /** 假设说明（为什么可能有效） */
  thesis: string
  /** 生成目标权重矩阵 */
  generate(bars: readonly (readonly Bar[])[], ctx?: StrategyContext): number[][]
  /** 默认参数网格（供参数搜索使用） */
  grid: Record<string, (number | boolean)[]>
}

/**
 * 把「单标的战术」的权重序列扩成 K 标的的矩阵。
 *
 * ⚠️ 设计要点（被单元测试抓到过）：单标的战术（如双均线）在 K 个标的上
 * **不能各自满仓** —— 那会让单 bar 总权重 = K，产生 K 倍隐性杠杆。
 * 正确做法是按 1/K 均分，使组合总权重仍 ≤ 1（与「等权持有一篮子」语义一致）。
 *
 * @param weightsPerBar 每根 bar 对该战术的单标的仓位（0..1）
 * @param K 标的数
 */
function expand(weightsPerBar: readonly number[], K: number): number[][] {
  const share = K > 0 ? 1 / K : 0
  return weightsPerBar.map(w => new Array<number>(K).fill(w * share))
}

/** 票池等权指数（用于大盘状态判断）。 */
export function equalWeightIndex(bars: readonly (readonly Bar[])[]): number[] {
  const T = bars[0]?.length ?? 0
  const out = new Array<number>(T).fill(0)
  for (let i = 0; i < T; i++) {
    let sum = 0
    for (const b of bars) {
      const base = barClose(b[0]!)
      sum += base > 0 ? barClose(b[i]!) / base : 1
    }
    out[i] = sum / bars.length
  }
  return out
}

/** 指数距 N 日高点的回撤（实时量，比均线穿越反应快）。 */
export function drawdownFromHigh(index: readonly number[], window: number): number[] {
  const out = new Array<number>(index.length).fill(0)
  for (let i = 0; i < index.length; i++) {
    let hi = -Infinity
    for (let j = Math.max(0, i - window + 1); j <= i; j++) if (index[j]! > hi) hi = index[j]!
    out[i] = hi > 0 ? (hi - index[i]!) / hi : 0
  }
  return out
}

/** 逐票滚动波动率矩阵 [K][T]。 */
function volMatrix(bars: readonly (readonly Bar[])[], window: number): (number | null)[][] {
  return bars.map(b => rollingStd(simpleReturns(b.map(barClose)), window))
}

// ══════════════════════════ 战术 1：双均线交叉 ══════════════════════════

/** 双均线交叉（单标的择时；多标的时各标的独立）。 */
export const maCross: Strategy = {
  id: 'ma_cross',
  name: '双均线交叉',
  thesis: '快线上穿慢线买入、下穿卖出；最基础的趋势跟踪基准。',
  generate(bars, ctx = {}) {
    const fast = Number(ctx.fast ?? 10)
    const slow = Number(ctx.slow ?? 30)
    const c = bars[0]!.map(barClose)
    const f = sma(c, fast)
    const s = sma(c, slow)
    const out: number[] = []
    let on = 0
    for (let i = 0; i < c.length; i++) {
      if (f[i] != null && s[i] != null) {
        if (f[i]! > s[i]!) on = 1
        else if (f[i]! < s[i]!) on = 0
      }
      out.push(on)
    }
    return expand(out, bars.length)
  },
  grid: { fast: [5, 10, 20], slow: [20, 30, 60] },
}

// ══════════════════════════ 战术 2：波动率目标仓位 ══════════════════════════

/** 波动率目标仓位（按已实现波动率反推仓位，压回撤）。 */
export const volTarget: Strategy = {
  id: 'vol_target',
  name: '波动率目标仓位',
  thesis: '波动上升时自动降仓，把组合波动压到目标水平 —— 以回撤优先。',
  generate(bars, ctx = {}) {
    const window = Number(ctx.window ?? 20)
    const target = Number(ctx.targetVol ?? 0.2)
    const cap = Number(ctx.cap ?? 1)
    const trendWin = Number(ctx.trend ?? 60)
    const c = bars[0]!.map(barClose)
    const sd = rollingStd(simpleReturns(c), window)
    const on = trendWin > 0 ? sma(c, trendWin) : null
    const out: number[] = []
    for (let i = 0; i < c.length; i++) {
      let w = 0
      const trendOk = on === null ? true : (on[i] != null && c[i]! > on[i]!)
      if (sd[i] != null && sd[i]! > 0 && trendOk) {
        const annVol = sd[i]! * Math.sqrt(243)
        w = Math.min(cap, target / annVol)
      }
      out.push(w)
    }
    return expand(out, bars.length)
  },
  grid: { window: [10, 20, 30], targetVol: [0.1, 0.15, 0.2, 0.25], trend: [0, 60, 120] },
}

// ══════════════════════════ 战术 3：横截面动量选股 ══════════════════════════

/**
 * 横截面动量选股（实证基准）。
 * 注意：样本内表现强（跑赢率 82%）但最差窗口 -50%；建议配合止损与趋势闸门使用。
 */
export const crossMomentum: Strategy = {
  id: 'cross_momentum',
  name: '横截面动量选股（前 N 等权）',
  thesis: '按 lookback 日收益排名，持有最强的 N 只，每 rebalance 日换仓。',
  generate(bars, ctx = {}) {
    const lookback = Number(ctx.lookback ?? 20)
    const topN = Number(ctx.topN ?? 10)
    const rebalance = Number(ctx.rebalance ?? 10)
    const momMin = Number(ctx.momMin ?? 0)
    const n = bars[0]!.length
    const K = bars.length
    const signals = Array.from({ length: n }, () => new Array<number>(K).fill(0))
    let current = new Array<number>(K).fill(0)
    for (let i = 0; i < n; i++) {
      if (i > 0 && i % rebalance === 0 && i >= lookback) {
        const scored: { k: number; mom: number }[] = []
        for (let k = 0; k < K; k++) {
          const c = barClose(bars[k]![i]!)
          const c0 = barClose(bars[k]![i - lookback]!)
          if (c0 > 0) scored.push({ k, mom: c / c0 - 1 })
        }
        scored.sort((a, b) => b.mom - a.mom)
        const picked = scored.slice(0, topN).filter(s => s.mom > momMin)
        current = new Array<number>(K).fill(0)
        if (picked.length) {
          const w = 1 / picked.length
          for (const p of picked) current[p.k] = w
        }
      }
      signals[i] = [...current]
    }
    return signals
  },
  grid: { lookback: [10, 20, 60], topN: [5, 10, 20], rebalance: [5, 10, 20] },
}

// ══════════════ 战术 4：动量 + 趋势闸门 + 个股止损【前向验证最优】══════════════

/**
 * 动量选股 + 趋势闸门 + 个股止损。
 *
 * 前向验证（只用历史窗口选参、在未来窗口测试）结果：
 * 超额中位 +11.33%、跑赢基准 6/9 窗口、回撤中位 17.73%。
 * 这是本项目实证出的最优可复现策略。
 */
export const momentumStop: Strategy = {
  id: 'momentum_stop',
  name: '动量选股+趋势闸门+个股止损',
  thesis: '动量选强 + 大盘均线闸门（空头空仓）+ 个股固定止损，三点组合把最差窗口从 -50% 压到 -17%。',
  generate(bars, ctx = {}) {
    const lookback = Number(ctx.lookback ?? 60)
    const topN = Number(ctx.topN ?? 3)
    const stopPct = Number(ctx.stopPct ?? 0.08)
    const rebalance = Number(ctx.rebalance ?? 5)
    const filterMa = Number(ctx.filterMa ?? 60)
    const bearGross = Number(ctx.bearGross ?? 0)
    const n = bars[0]!.length
    const K = bars.length
    const idx = equalWeightIndex(bars)
    const idxMa = filterMa > 0 ? sma(idx, filterMa) : null
    const signals = Array.from({ length: n }, () => new Array<number>(K).fill(0))
    let picks: number[] = []
    const entry = new Array<number | null>(K).fill(null)
    const stopped = new Array<boolean>(K).fill(false)

    for (let i = 0; i < n; i++) {
      const bearish = idxMa !== null && idxMa[i] != null && idx[i]! < idxMa[i]!
      const gross = bearish ? bearGross : 1
      // 个股止损检查
      if (stopPct > 0) {
        for (const k of picks) {
          if (stopped[k]) continue
          const e = entry[k]
          if (e != null && e > 0 && barClose(bars[k]![i]!) / e - 1 <= -stopPct) stopped[k] = true
        }
      }
      if (i > 0 && i % rebalance === 0 && i >= lookback) {
        const scored: { k: number; mom: number }[] = []
        for (let k = 0; k < K; k++) {
          const c = barClose(bars[k]![i]!)
          const c0 = barClose(bars[k]![i - lookback]!)
          if (c0 > 0) {
            const mom = c / c0 - 1
            if (mom > 0) scored.push({ k, mom })
          }
        }
        scored.sort((a, b) => b.mom - a.mom)
        picks = scored.slice(0, topN).map(x => x.k)
        for (const k of picks) {
          if (!stopped[k] && entry[k] == null) entry[k] = barClose(bars[k]![i]!)
        }
        for (let k = 0; k < K; k++) {
          if (!picks.includes(k)) { entry[k] = null; stopped[k] = false }
        }
      }
      const active = picks.filter(k => !stopped[k])
      if (gross > 0 && active.length) {
        const w = gross / active.length
        for (const k of active) signals[i]![k] = w
      }
    }
    return signals
  },
  grid: {
    lookback: [40, 60],
    topN: [3, 5],
    stopPct: [0, 0.05, 0.08, 0.12],
    filterMa: [0, 60],
    rebalance: [5, 10],
  },
}

// ══════════════ 战术 5：低波动 + 快速熔断 + 反波动加权 ══════════════

/**
 * 低波动选股 + 快速熔断 + 反波动率加权。
 *
 * ⚠️ 诚实标注：本策略样本内 Calmar 极高（0.999 vs momentumStop 0.320），
 * 但**真·前向验证下超额为负**（-3.81%、跑赢率仅 33%）—— 属于过拟合的典型。
 * 保留它作为「回撤极小」的参考实现，但不应作为收益策略推荐。
 */
export const lowVolCircuit: Strategy = {
  id: 'lowvol_circuit',
  name: '低波动量+快速熔断（回撤小，但前向验证超额不显著）',
  thesis: '低波选股 + 指数距高点回撤熔断 + 反波动率加权；回撤极小但收益不显著。',
  generate(bars, ctx = {}) {
    const lookback = Number(ctx.lookback ?? 60)
    const topN = Number(ctx.topN ?? 5)
    const rebalance = Number(ctx.rebalance ?? 5)
    const volWin = Number(ctx.volWin ?? 20)
    const volMaxPctile = Number(ctx.volMaxPctile ?? 0.6)
    const maxMom = Number(ctx.maxMom ?? 0.5)
    const circuitDd = Number(ctx.circuitDd ?? 0.05)
    const maFilter = Number(ctx.maFilter ?? 60)
    const n = bars[0]!.length
    const K = bars.length
    const idx = equalWeightIndex(bars)
    const idxMa = maFilter > 0 ? sma(idx, maFilter) : null
    const idxDd = drawdownFromHigh(idx, 20)
    const vols = volMatrix(bars, volWin)
    const signals = Array.from({ length: n }, () => new Array<number>(K).fill(0))
    let picks: number[] = []
    let weights: number[] = []

    for (let i = 0; i < n; i++) {
      const bearish = idxMa !== null && idxMa[i] != null && idx[i]! < idxMa[i]!
      const circuit = idxDd[i]! > circuitDd
      const gross = (bearish || circuit) ? 0 : 1
      if (i > 0 && i % rebalance === 0 && i >= lookback + volWin) {
        const cand: { k: number; mom: number; sd: number }[] = []
        for (let k = 0; k < K; k++) {
          const c = barClose(bars[k]![i]!)
          const c0 = barClose(bars[k]![i - lookback]!)
          if (!(c0 > 0)) continue
          const mom = c / c0 - 1
          if (mom <= 0 || mom > maxMom) continue
          const sd = vols[k]![i]
          if (sd == null) continue
          cand.push({ k, mom, sd })
        }
        if (cand.length) {
          const sds = cand.map(x => x.sd).sort((a, b) => a - b)
          const cut = sds[Math.floor(sds.length * volMaxPctile)] ?? Infinity
          const passed = cand.filter(x => x.sd <= cut).sort((a, b) => b.mom - a.mom)
          const chosen = passed.slice(0, topN)
          picks = chosen.map(x => x.k)
          const inv = chosen.map(x => 1 / Math.max(x.sd, 1e-4))
          const tot = inv.reduce((a, b) => a + b, 0) || 1
          weights = inv.map(v => v / tot)
        } else { picks = []; weights = [] }
      }
      if (gross > 0 && picks.length) {
        for (let j = 0; j < picks.length; j++) signals[i]![picks[j]!] = weights[j]! * gross
      }
    }
    return signals
  },
  grid: {
    lookback: [40, 60],
    topN: [3, 5, 10],
    volMaxPctile: [0.4, 0.6, 1],
    circuitDd: [0.03, 0.05, 0.08],
    maFilter: [0, 60],
    rebalance: [5, 10],
  },
}

// ══════════════════════════ 战术 6：短期反转 ══════════════════════════

/** 短期超跌反转（买跌幅最大者）；最差窗口最小但收益也最低。 */
export const shortReversal: Strategy = {
  id: 'short_reversal',
  name: '短期超跌反转',
  thesis: '买近 lookback 日跌幅最大的 N 只（均值回复），配趋势闸门避免下跌趋势接刀。',
  generate(bars, ctx = {}) {
    const lookback = Number(ctx.lookback ?? 5)
    const topN = Number(ctx.topN ?? 5)
    const rebalance = Number(ctx.rebalance ?? 3)
    const stopPct = Number(ctx.stopPct ?? 0.08)
    const filterMa = Number(ctx.filterMa ?? 60)
    const bearGross = Number(ctx.bearGross ?? 0)
    const n = bars[0]!.length
    const K = bars.length
    const idx = equalWeightIndex(bars)
    const idxMa = filterMa > 0 ? sma(idx, filterMa) : null
    const signals = Array.from({ length: n }, () => new Array<number>(K).fill(0))
    let picks: number[] = []
    const entry = new Array<number | null>(K).fill(null)
    const stopped = new Array<boolean>(K).fill(false)
    for (let i = 0; i < n; i++) {
      const bearish = idxMa !== null && idxMa[i] != null && idx[i]! < idxMa[i]!
      const gross = bearish ? bearGross : 1
      if (stopPct > 0) {
        for (const k of picks) {
          if (stopped[k]) continue
          const e = entry[k]
          if (e != null && e > 0 && barClose(bars[k]![i]!) / e - 1 <= -stopPct) stopped[k] = true
        }
      }
      if (i > 0 && i % rebalance === 0 && i >= lookback + 1) {
        const scored: { k: number; r: number }[] = []
        for (let k = 0; k < K; k++) {
          const c = barClose(bars[k]![i]!)
          const c0 = barClose(bars[k]![i - lookback]!)
          if (c0 > 0) scored.push({ k, r: c / c0 - 1 })
        }
        scored.sort((a, b) => a.r - b.r)
        picks = scored.slice(0, topN).map(x => x.k)
        for (const k of picks) if (!stopped[k] && entry[k] == null) entry[k] = barClose(bars[k]![i]!)
        for (let k = 0; k < K; k++) if (!picks.includes(k)) { entry[k] = null; stopped[k] = false }
      }
      const active = picks.filter(k => !stopped[k])
      if (gross > 0 && active.length) {
        const w = gross / active.length
        for (const k of active) signals[i]![k] = w
      }
    }
    return signals
  },
  grid: { lookback: [3, 5, 10], topN: [3, 5, 10], rebalance: [3, 5], stopPct: [0, 0.08], filterMa: [0, 60] },
}

/** 全部内置策略。 */
export const ALL_STRATEGIES: readonly Strategy[] = [
  maCross,
  volTarget,
  crossMomentum,
  momentumStop,
  lowVolCircuit,
  shortReversal,
]

/** 按 id 查找策略。 */
export function findStrategy(id: string): Strategy | undefined {
  return ALL_STRATEGIES.find(s => s.id === id)
}

/**
 * 便捷函数：用某策略跑一次回测。
 * @param bars 标的多序列
 * @param strategy 策略或策略 id
 * @param ctx 策略参数
 * @param options 回测选项
 */
export function runStrategy(
  bars: readonly (readonly Bar[])[],
  strategy: Strategy | string,
  ctx: StrategyContext = {},
  options: Parameters<typeof backtestTargetWeights>[2] = {},
) {
  const st = typeof strategy === 'string' ? findStrategy(strategy) : strategy
  if (!st) throw new RangeError(`unknown strategy: ${String(strategy)}`)
  const signals = st.generate(bars, ctx)
  return { strategy: st.id, ctx, ...backtestTargetWeights(bars, signals, options), signals }
}
