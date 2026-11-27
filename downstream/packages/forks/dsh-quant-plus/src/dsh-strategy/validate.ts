/**
 * 策略稳健性检验（六道关卡）—— dsh-strategy 域。
 *
 * 来源：A 股策略研究过程中反复被"假发现"欺骗后固化出的判定流程。
 * 三个真实案例驱动了本模块：
 *   1. 隐性杠杆：某策略单 bar 总权重 294，报出 Calmar 132（归一后 0.05%）
 *   2. 行业中性化：中位收益 +2.40% → +9.01%，但更好窗口仅 6/11（抛硬币）
 *   3. t=2.28 的"显著"：剔除任一最好窗口后 t 掉到 1.64~1.90，全部不显著
 *
 * 用法：把逐窗口的超额收益序列交给 `validateStrategy`，得到一份可读的体检报告。
 * 本模块是纯函数，无网络、无文件依赖。
 */
import { meanSeNW, pValue, power, deflatedSharpe } from './stats.js'

/** 单条检验结论。 */
export interface GateResult {
  /** 关卡名 */
  gate: string
  /** 是否通过 */
  pass: boolean
  /** 人类可读的实测值 */
  detail: string
}

/** 体检报告。 */
export interface ValidationReport {
  /** 总体判定：全部通过才为 true */
  pass: boolean
  /** 六道关卡的逐条结果 */
  gates: GateResult[]
  /** 汇总统计 */
  summary: {
    n: number
    meanExcessPct: number
    medianExcessPct: number
    sdExcessPct: number
    tStat: number
    pValue: number
    /** 当前样本量下能检测到的最小效应（80% 功效），单位 % */
    detectableEffectPct: number
    /** 对观测效应量所需的样本量（80% 功效） */
    requiredN: number
  }
}

/** 中位数。 */
function median(xs: readonly number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** 总体标准差。 */
function sd(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length)
}

/**
 * 达到目标功效所需样本量（二分求解，避免依赖 stats 的内部实现细节）。
 */
function requiredN(effect: number, sdv: number, targetPower = 0.8, alpha = 0.05): number {
  if (effect === 0 || sdv <= 0) return Infinity
  let lo = 2
  let hi = 100000
  if (power(Math.abs(effect), sdv, lo, alpha) >= targetPower) return lo
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (power(Math.abs(effect), sdv, mid, alpha) >= targetPower) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** 当前样本量下可检测的效应量（80% 功效）。 */
function detectableEffect(sdv: number, n: number, targetPower = 0.8, alpha = 0.05): number {
  if (n < 2 || sdv <= 0) return Infinity
  let lo = 0
  let hi = 10 * sdv + 1
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (power(mid, sdv, n, alpha) >= targetPower) hi = mid
    else lo = mid
  }
  return (lo + hi) / 2
}

/** 检验选项。 */
export interface ValidateOptions {
  /** 显著性水平，默认 0.05 */
  alpha?: number
  /** 参数搜索/策略尝试次数（用于 Deflated Sharpe），默认 1 */
  trials?: number
  /** 逐窗口胜率的最低要求，默认 0.6 */
  minBeatRate?: number
  /** 每窗口收益的夏普（用于 Deflated Sharpe）；缺省用超额/其标准差推算 */
  sharpePerPeriod?: number
}

/**
 * 对逐窗口超额收益做六道关卡检验。
 *
 * @param excessPerWindow 每个不重叠窗口相对基准的超额收益（百分点，如 3.5 表示 +3.5%）
 * @param options 检验参数
 * @returns 体检报告
 *
 * @example
 * const r = validateStrategy([2.1, -1.3, 5.4, ...], { trials: 21 })
 * if (!r.pass) console.log(r.gates.filter(g => !g.pass).map(g => g.gate))
 */
export function validateStrategy(
  excessPerWindow: readonly number[],
  options: ValidateOptions = {},
): ValidationReport {
  const alpha = options.alpha ?? 0.05
  const trials = Math.max(1, options.trials ?? 1)
  const minBeat = options.minBeatRate ?? 0.6
  const n = excessPerWindow.length

  const meanExcess = n ? excessPerWindow.reduce((a, b) => a + b, 0) / n : 0
  const medExcess = median(excessPerWindow)
  const sdExcess = sd(excessPerWindow)
  const { t } = n >= 2 ? meanSeNW(excessPerWindow, 1) : { t: 0 }
  const p = pValue(t)
  const beatRate = n ? excessPerWindow.filter(x => x > 0).length / n : 0
  const detect = detectableEffect(sdExcess, n, 0.8, alpha)
  const needN = requiredN(meanExcess, sdExcess, 0.8, alpha)

  const gates: GateResult[] = []

  // 关卡 1：逐窗口胜率显著偏离 50%
  gates.push({
    gate: '1. 逐窗口胜率',
    pass: beatRate >= minBeat,
    detail: `${(beatRate * 100).toFixed(0)}%（阈值 ${(minBeat * 100).toFixed(0)}%，n=${n}）`,
  })

  // 关卡 2：均值与中位同向改善（都为正在更可信；一正一负说明被极端值拉动）
  const sameSign = (meanExcess > 0 && medExcess > 0) || (meanExcess < 0 && medExcess < 0)
  gates.push({
    gate: '2. 均值与中位同向',
    pass: sameSign,
    detail: `均值 ${meanExcess.toFixed(2)}% / 中位 ${medExcess.toFixed(2)}%` + (sameSign ? '' : '（背离，疑被极端值拉动）'),
  })

  // 关卡 3：t 检验显著（Newey-West 校正）
  gates.push({
    gate: '3. t 检验显著',
    pass: p < alpha,
    detail: `t=${t.toFixed(2)}, p=${p.toFixed(4)}（阈值 ${alpha}）`,
  })

  // 关卡 4：leave-one-out 稳健性 —— 剔除任一最好窗口后仍显著
  // 这是最有杀伤力的一关：真实效应不会被单个窗口支撑。
  let looPass = true
  let looDetail = 'n<3 无法检验'
  if (n >= 3) {
    const order = [...excessPerWindow.keys()].sort((a, b) => excessPerWindow[b]! - excessPerWindow[a]!)
    const worstT = Math.min(...order.slice(0, Math.min(3, n)).map(i => {
      const rest = excessPerWindow.filter((_, j) => j !== i)
      return meanSeNW(rest, 1).t
    }))
    looPass = pValue(worstT) < alpha
    looDetail = `剔除任一最好窗口后最差 t=${worstT.toFixed(2)}` + (looPass ? '（仍显著）' : '（失去显著性 → 结果由个别窗口主导）')
  }
  gates.push({ gate: '4. Leave-one-out 稳健', pass: looPass, detail: looDetail })

  // 关卡 5：Deflated Sharpe —— 校正"试了多少次"
  const sharpe = options.sharpePerPeriod ?? (sdExcess > 0 ? (meanExcess / 100) / (sdExcess / 100) * Math.sqrt(n) : 0)
  const dsr = deflatedSharpe(sharpe, n, trials, 0, 0)
  gates.push({
    gate: '5. Deflated Sharpe',
    pass: dsr.significant,
    detail: `夏普 ${sharpe.toFixed(2)} vs 最小显著 ${Number.isFinite(dsr.minSharpe) ? dsr.minSharpe.toFixed(2) : '∞'}（trials=${trials}）`,
  })

  // 关卡 6：功效充分 —— 样本量是否足以检测观测到的效应
  // 若功效低，则"不显著"不能作为"无效"的证据（反之亦然）。
  const powerNow = n >= 2 ? power(Math.abs(meanExcess) / 100, sdExcess / 100, n, alpha) : 0
  gates.push({
    gate: '6. 功效充分',
    pass: powerNow >= 0.8,
    detail: `功效 ${powerNow.toFixed(2)}；当前 n=${n} 可检测 ≥${detect.toFixed(2)}%；如需 80% 功效需 n≈${Number.isFinite(needN) ? needN : '∞'}`,
  })

  return {
    pass: gates.every(g => g.pass),
    gates,
    summary: {
      n,
      meanExcessPct: meanExcess,
      medianExcessPct: medExcess,
      sdExcessPct: sdExcess,
      tStat: t,
      pValue: p,
      detectableEffectPct: detect,
      requiredN: needN,
    },
  }
}
