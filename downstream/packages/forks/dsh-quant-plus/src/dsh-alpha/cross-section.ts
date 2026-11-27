/**
 * 截面因子评估（纯函数、零依赖）—— dsh-alpha 域扩展。
 *
 * 背景：上游 `factorEvaluate` 的文档建议「多资产截面：把截面按时间摊平为
 * 序列后传入」，但该用法在数学上不成立：`lagPair` 会把 factor[i] 与
 * forwardReturns[i+1] 错位配对，摊平后等于拿「不同资产、不同时点」的样本
 * 交叉配对，IC 完全失真（且静默、不报错）。
 *
 * 本模块提供正确的截面口径：**每个时点在各资产之间做一次横截面相关**，
 * 再对时间序列上的 IC 求均值/标准差（即业界标准 IC / ICIR / t 值）。
 *
 * 约定（与上游对齐契约一致）：
 * - `factor[t][a]` 与 `forwardReturns[t][a]` 在同一时点 t 对齐；
 *   `forwardReturns[t][a]` 表示资产 a 从 t 到 t+1 的收益（由调用方保证，无未来函数）。
 * - 缺失值用 `null` 表示（NaN/Infinity 不可达）；该时点资产数不足 minAssets 时跳过。
 * - 所有导出均为纯函数，isConcurrencySafe 语义成立。
 */

/** 单个时点的截面结果。 */
export interface CrossSectionPoint {
  /** 时点索引（0-based，对应输入矩阵的行号） */
  period: number
  /** 该时点的截面 Pearson IC */
  ic: number
  /** 该时点的截面 Spearman RankIC */
  rankIc: number
  /** 该时点参与计算的资产数 */
  assets: number
}

/** 截面因子评估结果。 */
export interface CrossSectionEval {
  /** IC 时间序列均值（核心指标） */
  meanIc: number
  /** IC 时间序列标准差 */
  icStd: number
  /** ICIR = meanIc / icStd（IC 的稳定性，越高越稳定） */
  icir: number
  /** IC 的 t 统计量 = meanIc / (icStd / sqrt(n))，用于显著性判断 */
  icTStat: number
  /** 正 IC 占比 %（方向一致性） */
  icPositiveRate: number
  /** RankIC 均值 */
  meanRankIc: number
  /** 逐时点明细（跳过样本不足的时点） */
  series: CrossSectionPoint[]
  /** 有效时点数 */
  periods: number
}

/** 平均秩（并列取平均秩）。 */
function averageRanks(values: readonly number[]): number[] {
  const n = values.length
  const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!)
  const ranks = new Array<number>(n).fill(0)
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && values[order[j + 1]!] === values[order[i]!]) j++
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[order[k]!] = avg
    i = j + 1
  }
  return ranks
}

/** Pearson 相关（等长数组；方差为 0 时返回 0）。 */
function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 2) return 0
  let sa = 0
  let sb = 0
  for (let i = 0; i < n; i++) {
    sa += a[i]!
    sb += b[i]!
  }
  const ma = sa / n
  const mb = sb / n
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < n; i++) {
    cov += (a[i]! - ma) * (b[i]! - mb)
    va += (a[i]! - ma) ** 2
    vb += (b[i]! - mb) ** 2
  }
  if (va === 0 || vb === 0) return 0
  return cov / Math.sqrt(va * vb)
}

/**
 * 逐时点截面因子评估。
 *
 * @param factorMatrix - 因子矩阵 [时点][资产]，缺失用 null。
 * @param forwardReturns - 未来收益矩阵 [时点][资产]，与 factorMatrix 同形。
 * @param minAssets - 单个截面至少需要的资产数（默认 5，不足则跳过该时点）。
 * @returns 截面 IC / ICIR / t 值 / 逐时点明细。
 */
export function factorEvaluateCrossSection(
  factorMatrix: readonly (readonly (number | null)[])[],
  forwardReturns: readonly (readonly (number | null)[])[],
  minAssets = 5,
): CrossSectionEval {
  if (!Number.isInteger(minAssets) || minAssets < 2) {
    throw new RangeError(`minAssets must be an integer >= 2, got ${minAssets}`)
  }
  const periods = Math.min(factorMatrix.length, forwardReturns.length)
  const series: CrossSectionPoint[] = []
  for (let t = 0; t < periods; t++) {
    const fRow = factorMatrix[t] ?? []
    const rRow = forwardReturns[t] ?? []
    const width = Math.min(fRow.length, rRow.length)
    const f: number[] = []
    const r: number[] = []
    for (let a = 0; a < width; a++) {
      const fv = fRow[a]
      const rv = rRow[a]
      if (fv === null || fv === undefined || rv === null || rv === undefined) continue
      f.push(fv)
      r.push(rv)
    }
    if (f.length < minAssets) continue
    series.push({ period: t, ic: pearson(f, r), rankIc: pearson(averageRanks(f), averageRanks(r)), assets: f.length })
  }
  const n = series.length
  if (n === 0) {
    return { meanIc: 0, icStd: 0, icir: 0, icTStat: 0, icPositiveRate: 0, meanRankIc: 0, series, periods: 0 }
  }
  const meanIc = series.reduce((a, p) => a + p.ic, 0) / n
  const icStd = Math.sqrt(series.reduce((a, p) => a + (p.ic - meanIc) ** 2, 0) / n)
  const meanRankIc = series.reduce((a, p) => a + p.rankIc, 0) / n
  const icir = icStd === 0 ? 0 : meanIc / icStd
  const icTStat = icStd === 0 ? 0 : meanIc / (icStd / Math.sqrt(n))
  const icPositiveRate = (series.filter(p => p.ic > 0).length / n) * 100
  return { meanIc, icStd, icir, icTStat, icPositiveRate, meanRankIc, series, periods: n }
}
