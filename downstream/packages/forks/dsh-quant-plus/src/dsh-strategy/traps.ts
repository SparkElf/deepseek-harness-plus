/**
 * 回测陷阱检测（Backtest trap detection）—— dsh-strategy 域。
 *
 * 来源：A 股策略研究过程中实际踩到的**五个陷阱**，每一个都让一个"好结果"变成假的。
 * 本模块把它们的检测逻辑固化成代码 —— 因为人工检查会漏、会忘。
 *
 * | # | 陷阱 | 表面数字 | 真实情况 | 检测函数 |
 * |---|---|---|---|---|
 * | 1 | 隐性杠杆 | Calmar 132 | 0.134 | {@link detectHiddenLeverage} |
 * | 2 | 极端值主导 | t=2.28 显著 | 剔除1窗口失效 | {@link detectOutlierDependence} |
 * | 3 | 幸存者偏差 | +197pp 超额 | −45pp | {@link detectSurvivorshipBias} |
 * | 4 | 跳空不可交易 | +0.477% 次日 | −0.256% | {@link detectGapDependence} |
 * | 5 | 逆向选择 | 封死涨停 +5.74% | 买不到 | {@link detectAdverseSelection} |
 *
 * 共同规律：**统计量度量的不是「决策者实际能拿到的东西」**。
 */

/** 单条陷阱检测结果。 */
export interface TrapFinding {
  /** 是否检出该陷阱 */
  detected: boolean
  /** 严重程度：none / mild / severe */
  severity: 'none' | 'mild' | 'severe'
  /** 实测证据（人类可读） */
  evidence: string
}

/** 陷阱 1：隐性杠杆 —— 信号总权重长期超过 1。 */
export function detectHiddenLeverage(maxGrossRaw: number, cap = 1): TrapFinding {
  if (maxGrossRaw <= cap + 1e-9) {
    return { detected: false, severity: 'none', evidence: `最大总权重 ${maxGrossRaw.toFixed(2)} ≤ ${cap}（无杠杆）` }
  }
  const ratio = maxGrossRaw / cap
  return {
    detected: true,
    severity: ratio >= 3 ? 'severe' : 'mild',
    evidence:
      `信号最大总权重 ${maxGrossRaw.toFixed(2)}，是上限的 ${ratio.toFixed(2)} 倍。` +
      `引擎已按 grossCap 归一，但**报告的收益是归一后的**；若策略本想满仓单一标的，` +
      `需检查权重语义是否符合预期。`,
  }
}

/** 陷阱 2：极端值主导 —— 剔除最好/最差窗口后结论翻转。 */
export function detectOutlierDependence(
  perWindowValues: readonly number[],
  options: { dropCount?: number; threshold?: number } = {},
): TrapFinding {
  const dropCount = options.dropCount ?? 3
  const n = perWindowValues.length
  if (n < 5) return { detected: false, severity: 'none', evidence: `样本仅 ${n} 个，无法判断` }
  const mean = (a: readonly number[]) => a.reduce((x, y) => x + y, 0) / a.length
  const full = mean(perWindowValues)
  const order = [...perWindowValues.keys()].sort((a, b) => perWindowValues[b]! - perWindowValues[a]!)
  const drops = Math.min(dropCount, Math.floor(n / 3))
  const trimmed = order.slice(0, drops).map(i => i)
  const rest = perWindowValues.filter((_, i) => !trimmed.includes(i))
  const after = mean(rest)
  const flipped = (full > 0 && after <= 0) || (full < 0 && after >= 0)
  const shrink = Math.abs(full) > 0 ? 1 - Math.abs(after) / Math.abs(full) : 0
  if (!flipped && shrink < 0.5) {
    return { detected: false, severity: 'none', evidence: `剔除最优 ${drops} 个后均值 ${full.toFixed(3)} → ${after.toFixed(3)}（稳定）` }
  }
  return {
    detected: true,
    severity: flipped ? 'severe' : 'mild',
    evidence:
      `均值 ${full.toFixed(3)} → 剔除最优 ${drops}/${n} 个后 ${after.toFixed(3)}` +
      (flipped ? '（**符号翻转**：结果由少数窗口主导）' : `（衰减 ${(shrink * 100).toFixed(0)}%）`),
  }
}

/**
 * 陷阱 3：幸存者偏差 —— 用有偏票池（如"当前指数成分股"）回溯历史。
 *
 * 无法从单一结果检测，需要**两个票池的对照**。
 *
 * @param excessBiased   有偏票池上的超额收益（百分点）
 * @param excessUnbiased 较无偏票池上的超额收益（百分点）
 */
export function detectSurvivorshipBias(excessBiased: number, excessUnbiased: number): TrapFinding {
  const gap = excessBiased - excessUnbiased
  const absUnbiased = Math.abs(excessUnbiased)
  // 有偏正、无偏负 → 典型幸存者偏差
  if (excessBiased > 0 && excessUnbiased <= 0) {
    return {
      detected: true,
      severity: 'severe',
      evidence:
        `有偏票池超额 +${excessBiased.toFixed(1)}pp，较无偏票池 ${excessUnbiased.toFixed(1)}pp —— ` +
        `**符号翻转**，结论由票池构造决定，不是策略能力。`,
    }
  }
  if (gap > Math.max(10, absUnbiased * 0.5)) {
    return {
      detected: true,
      severity: 'mild',
      evidence: `两票池差距 ${gap.toFixed(1)}pp，显著大于无偏口径的 ${absUnbiased.toFixed(1)}pp —— 存在票池选择效应。`,
    }
  }
  return { detected: false, severity: 'none', evidence: `两票池差距 ${gap.toFixed(1)}pp（可接受）` }
}

/**
 * 陷阱 4：跳空依赖 —— 收益主要来自隔夜跳空（无法在信号价成交）。
 *
 * @param closeToClose 收盘→次日收盘的平均收益
 * @param overnightGap 隔夜跳空（收盘→次日开盘）的平均收益
 * @param intraday     日内（次日开盘→次日收盘）的平均收益
 */
export function detectGapDependence(
  closeToClose: number,
  overnightGap: number,
  intraday: number,
): TrapFinding {
  if (Math.abs(closeToClose) < 1e-9) {
    return { detected: false, severity: 'none', evidence: '无收益可比' }
  }
  const gapShare = Math.abs(overnightGap) / Math.abs(closeToClose)
  // 关键判据：统计收益为正，但可实现（日内）为负
  const flipped = closeToClose > 0 && intraday <= 0
  if (flipped) {
    return {
      detected: true,
      severity: 'severe',
      evidence:
        `统计收益 +${closeToClose.toFixed(3)}% 全部来自跳空（+${overnightGap.toFixed(3)}%）；` +
        `可实现部分（日内）为 ${intraday.toFixed(3)}% —— **信号价无法成交**。`,
    }
  }
  if (gapShare > 0.7) {
    return {
      detected: true,
      severity: 'mild',
      evidence: `跳空占统计收益的 ${(gapShare * 100).toFixed(0)}%（日内 ${intraday.toFixed(3)}%）—— 大部分收益不可实现。`,
    }
  }
  return { detected: false, severity: 'none', evidence: `跳空占比 ${(gapShare * 100).toFixed(0)}%（可接受）` }
}

/**
 * 陷阱 5：逆向选择 —— 能成交的样本系统性劣于不能成交的。
 *
 * @param fillable   可成交样本的平均收益（如盘中开板的涨停）
 * @param unfillable 不可成交样本的平均收益（如封死的一字板）
 */
export function detectAdverseSelection(fillable: number, unfillable: number): TrapFinding {
  if (unfillable <= fillable) {
    return { detected: false, severity: 'none', evidence: `不可成交 ${unfillable.toFixed(3)}% ≤ 可成交 ${fillable.toFixed(3)}%（无逆向选择）` }
  }
  const gap = unfillable - fillable
  const severe = fillable <= 0 && unfillable > 0
  return {
    detected: true,
    severity: severe ? 'severe' : 'mild',
    evidence:
      `不可成交样本 ${unfillable.toFixed(3)}% 优于可成交样本 ${fillable.toFixed(3)}%（差 ${gap.toFixed(3)}pp）` +
      (severe ? ' —— **正收益全部买不到，买得到的为负**。' : '。'),
  }
}

/** 全部陷阱的汇总报告。 */
export interface TrapReport {
  /** 检出的陷阱数 */
  detectedCount: number
  /** 是否存在严重陷阱 */
  hasSevere: boolean
  /** 逐条结果 */
  findings: Record<string, TrapFinding>
  /** 结论 */
  verdict: string
}

/**
 * 汇总运行全部陷阱检测。
 *
 * @param input 各检测所需的输入（能提供多少就检测多少）
 */
export function auditBacktest(input: {
  maxGrossRaw?: number
  perWindowValues?: readonly number[]
  survivorship?: { biased: number; unbiased: number }
  gap?: { closeToClose: number; overnightGap: number; intraday: number }
  adverseSelection?: { fillable: number; unfillable: number }
}): TrapReport {
  const findings: Record<string, TrapFinding> = {}
  if (input.maxGrossRaw !== undefined) findings['1.隐性杠杆'] = detectHiddenLeverage(input.maxGrossRaw)
  if (input.perWindowValues) findings['2.极端值主导'] = detectOutlierDependence(input.perWindowValues)
  if (input.survivorship) findings['3.幸存者偏差'] = detectSurvivorshipBias(input.survivorship.biased, input.survivorship.unbiased)
  if (input.gap) findings['4.跳空依赖'] = detectGapDependence(input.gap.closeToClose, input.gap.overnightGap, input.gap.intraday)
  if (input.adverseSelection) findings['5.逆向选择'] = detectAdverseSelection(input.adverseSelection.fillable, input.adverseSelection.unfillable)

  const list = Object.values(findings)
  const detectedCount = list.filter(f => f.detected).length
  const hasSevere = list.some(f => f.severity === 'severe')
  const verdict = hasSevere
    ? `检出 ${detectedCount} 个陷阱（含**严重**），该结果**不可作为策略有效性的证据**。`
    : detectedCount > 0
      ? `检出 ${detectedCount} 个轻度陷阱，需进一步核查。`
      : '未检出已知陷阱。'
  return { detectedCount, hasSevere, findings, verdict }
}
